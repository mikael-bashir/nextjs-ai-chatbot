#!/usr/bin/env node
// Local Claude Agent — bridge
// ---------------------------------------------------------------------------
// Runs on YOUR machine and wraps your locally-installed, logged-in Claude Code
// CLI. The CompeteMath web app talks to this bridge directly from your browser
// (browser -> http://localhost:PORT), so your Claude subscription powers the
// runs and prompts/results never touch the app's server.
//
// Run it:   node bridge.mjs
// Requires: Claude Code installed and logged in (`claude login`).
//
// Security model:
//   * Binds to 127.0.0.1 only — never exposed on your network.
//   * Requires a secret token (printed on startup) on every request.
//   * CORS-allowlists specific app origins only (not "*").
//   * Only accepts a fixed, validated set of run options — it will NOT run an
//     arbitrary binary or arbitrary CLI flags supplied by the page.
// ---------------------------------------------------------------------------

import { createServer } from "node:http"
import { spawn } from "node:child_process"
import { randomBytes, timingSafeEqual, randomUUID } from "node:crypto"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

// --- Resilience: never let a dropped socket take down the whole bridge. -------
// The relay connection and remote MCP servers (HF Spaces sleep, tunnels reset)
// routinely close sockets mid-stream; undici surfaces that as an async
// "terminated" / UND_ERR_SOCKET rejection. With no handler, Node exits the
// process — so the relay's own reconnect loop never gets to run. Swallow ONLY
// these transient network errors and keep running; anything else still fails
// fast so real bugs surface.
const isTransientNetErr = (e) => {
  const s = String(
    e?.code || e?.cause?.code || e?.cause?.message || e?.message || e,
  )
  return /UND_ERR_SOCKET|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EPIPE|ENETUNREACH|EAI_AGAIN|terminated|other side closed|socket hang up|fetch failed/i.test(
    s,
  )
}
// An AbortError is us tearing a connection down on purpose (timeout / completion)
// — it is expected, not a fault, so stay silent.
const isAbort = (e) =>
  (e?.name || e?.cause?.name) === "AbortError" ||
  (e?.code || e?.cause?.code) === "ABORT_ERR"
process.on("unhandledRejection", (err) => {
  if (isAbort(err)) return
  if (isTransientNetErr(err))
    return console.error(
      "[bridge] transient network error (continuing):",
      err?.message || err,
    )
  console.error("[bridge] unhandledRejection:", err)
})
process.on("uncaughtException", (err) => {
  if (isAbort(err)) return
  if (isTransientNetErr(err))
    return console.error(
      "[bridge] transient network error (continuing):",
      err?.message || err,
    )
  console.error("[bridge] uncaughtException:", err)
  process.exit(1)
})

const PORT = Number(process.env.PORT || 4123)
const CLAUDE_BIN = process.env.CLAUDE_BIN || "claude"
// Free-text tag for the research tables (Leak River / Leak Stronghold) — set it
// when launching the bridge to label a batch of runs as belonging to a
// particular experiment/fix version, so before/after data isn't conflated.
const BRIDGE_BUILD = process.env.BRIDGE_BUILD_TAG || null
// When the proof gate confirms mid-stream we interrupt the CLI (SIGINT) so it
// flushes its final `result` frame — the sole carrier of total_cost_usd. This is
// the grace window before we hard-kill a CLI that didn't exit after flushing.
const PROOF_STOP_GRACE_MS = Number(process.env.PROOF_STOP_GRACE_MS) || 8000
// Auto-generate a token if none supplied. Copy it into the app UI once.
const TOKEN = process.env.BRIDGE_TOKEN || randomBytes(24).toString("base64url")
const MAX_OUTPUT_BYTES = 5 * 1024 * 1024

// Origins allowed to call this bridge. Override with ALLOWED_ORIGINS (comma-sep).
// Wildcards match a single label (e.g. https://*.competemath.com matches any
// preview subdomain). localhost/127.0.0.1 on any port are always allowed for dev.
const ALLOWED_ORIGINS = (
  process.env.ALLOWED_ORIGINS ||
  "https://competemath.com,https://*.competemath.com,https://*.preview.leak.competemath.com"
)
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean)

const PERMISSION_MODES = new Set(["default", "acceptEdits", "plan", "bypassPermissions"])

function originAllowed(origin) {
  if (!origin) return false
  if (/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) return true
  return ALLOWED_ORIGINS.some((pattern) => {
    const rx = new RegExp(
      "^" + pattern.replace(/[.]/g, "\\.").replace(/\*/g, "[^.]+") + "$",
    )
    return rx.test(origin)
  })
}

function tokenValid(req) {
  const provided =
    req.headers["x-bridge-token"] ||
    (req.headers.authorization || "").replace(/^Bearer\s+/i, "")
  if (!provided) return false
  const a = Buffer.from(String(provided))
  const b = Buffer.from(TOKEN)
  return a.length === b.length && timingSafeEqual(a, b)
}

function setCors(req, res) {
  const origin = req.headers.origin
  if (originAllowed(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin)
    res.setHeader("Vary", "Origin")
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
    res.setHeader("Access-Control-Allow-Headers", "content-type, x-bridge-token, authorization")
    // Chrome's Private Network Access: public HTTPS page -> private localhost
    // sends this preflight header and requires this response header.
    if (req.headers["access-control-request-private-network"] === "true") {
      res.setHeader("Access-Control-Allow-Private-Network", "true")
    }
    return true
  }
  return false
}

function json(res, status, body) {
  const payload = JSON.stringify(body)
  res.writeHead(status, { "content-type": "application/json" })
  res.end(payload)
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = ""
    req.on("data", (c) => {
      data += c
      if (data.length > 2 * 1024 * 1024) reject(new Error("body too large"))
    })
    req.on("end", () => resolve(data))
    req.on("error", reject)
  })
}

// Build a safe, fixed set of CLI flags. Anything not modelled here is ignored —
// the page cannot inject arbitrary flags or a different binary.
// Tools the prover subagents (planner / minions / finisher / tree nodes) are NOT
// allowed. WebSearch/WebFetch are literature-browsing escape hatches that let the
// agent "discover" a goal is an open conjecture and stop proving — cut them so it
// stays in the compiler. Tune here (e.g. add "Bash" to also cut numeric probing).
const PROVER_DISALLOWED_TOOLS = ["WebSearch", "WebFetch"]

function buildArgs(prompt, options = {}) {
  const args = ["-p", String(prompt), "--output-format", "json"]
  if (typeof options.model === "string" && options.model.trim())
    args.push("--model", options.model.trim())
  if (PERMISSION_MODES.has(options.permissionMode))
    args.push("--permission-mode", options.permissionMode)
  if (typeof options.allowedTools === "string" && options.allowedTools.trim())
    args.push("--allowedTools", options.allowedTools.trim())
  if (Number.isFinite(options.maxTurns) && options.maxTurns > 0)
    args.push("--max-turns", String(Math.floor(options.maxTurns)))
  if (typeof options.systemPromptAppend === "string" && options.systemPromptAppend.trim())
    args.push("--append-system-prompt", options.systemPromptAppend.trim())
  // Leanness flags — for stateless tasks (e.g. problem generation) that need no
  // tools/MCP: replacing the system prompt and dropping tool schemas cuts the
  // per-call context from ~17k tokens to ~4k, which matters a lot under a
  // subscription's rate limits when running in a loop.
  if (typeof options.systemPrompt === "string" && options.systemPrompt.trim())
    args.push("--system-prompt", options.systemPrompt.trim())
  if (typeof options.disallowedTools === "string" && options.disallowedTools.trim())
    args.push("--disallowedTools", ...options.disallowedTools.trim().split(/\s+/))
  if (options.strictMcpConfig) args.push("--strict-mcp-config")
  if (options.excludeDynamicSections)
    args.push("--exclude-dynamic-system-prompt-sections")
  return args
}

function extractText(stdout) {
  const t = stdout.trim()
  if (!t) return ""
  try {
    const parsed = JSON.parse(t)
    if (typeof parsed?.result === "string") return parsed.result
    return t
  } catch {
    return t
  }
}

// Total tokens across all buckets of a claude usage object (input + both cache
// tiers + output), used to accumulate a run-level token count alongside cost.
function usageTokens(u) {
  if (!u || typeof u !== "object") return 0
  return (
    (u.input_tokens || 0) +
    (u.cache_creation_input_tokens || 0) +
    (u.cache_read_input_tokens || 0) +
    (u.output_tokens || 0)
  )
}

// Pull token usage + cost out of claude's --output-format json result so the UI
// can display per-call token counts and running totals.
function extractMeta(stdout) {
  try {
    const p = JSON.parse(stdout.trim())
    return {
      usage: p?.usage ?? null,
      costUsd: typeof p?.total_cost_usd === "number" ? p.total_cost_usd : null,
    }
  } catch {
    return { usage: null, costUsd: null }
  }
}

function runClaude(args, { cwd, timeoutMs, killSignal, maxOutputTokens }) {
  return new Promise((resolve) => {
    const start = Date.now()
    let child
    try {
      // Array args + shell:false => the prompt is passed literally and can
      // never be reinterpreted by a shell. stdin ignored: the prompt is passed
      // via -p, so closing stdin avoids the CLI's "no stdin data" 3s warning.
      // maxOutputTokens raises CLAUDE_CODE_MAX_OUTPUT_TOKENS (default 32k) so a
      // heavily-reasoning task (hard/nested generation) doesn't error out.
      child = spawn(CLAUDE_BIN, args, {
        cwd: cwd || process.cwd(),
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
        env: maxOutputTokens
          ? { ...process.env, CLAUDE_CODE_MAX_OUTPUT_TOKENS: String(maxOutputTokens) }
          : process.env,
      })
    } catch (err) {
      resolve({ ok: false, text: "", exitCode: null, durationMs: 0, timedOut: false, stderr: String(err) })
      return
    }
    let stdout = ""
    let stderr = ""
    let bytes = 0
    let timedOut = false
    let aborted = false
    // timeoutMs <= 0 means "no cap" (caller relies on the UI terminate button).
    const timer =
      timeoutMs > 0
        ? setTimeout(() => {
            timedOut = true
            child.kill("SIGKILL")
          }, timeoutMs)
        : null
    // Kill the process if the caller (browser) disconnects — this is what makes
    // the UI "Terminate" button actually stop claude, so an uncapped run can't
    // keep burning tokens after you cancel it.
    if (killSignal) {
      const onAbort = () => {
        aborted = true
        child.kill("SIGKILL")
      }
      if (killSignal.aborted) onAbort()
      else killSignal.addEventListener("abort", onAbort, { once: true })
    }

    child.on("error", (err) => {
      if (timer) clearTimeout(timer)
      resolve({
        ok: false,
        text: "",
        exitCode: null,
        durationMs: Date.now() - start,
        timedOut: false,
        stderr: `Failed to launch "${CLAUDE_BIN}": ${err.message}`,
      })
    })
    child.stdout?.on("data", (c) => {
      bytes += c.length
      if (bytes <= MAX_OUTPUT_BYTES) stdout += c
    })
    child.stderr?.on("data", (c) => (stderr += c))
    child.on("close", (code) => {
      if (timer) clearTimeout(timer)
      const meta = extractMeta(stdout)
      resolve({
        ok: code === 0 && !timedOut && !aborted,
        text: extractText(stdout),
        usage: meta.usage,
        costUsd: meta.costUsd,
        exitCode: code,
        durationMs: Date.now() - start,
        timedOut,
        aborted,
        stderr: stderr.slice(0, 4000),
      })
    })
  })
}

// Streaming twin of /run: identical contract (prompt + options) but instead of
// one silent multi-minute POST, runs claude with stream-json (+ partial message
// deltas) and mirrors EVERY step over SSE — thinking, tool calls/results, text —
// in the same event shapes /prove-stream emits, so the app's existing console
// plumbing renders it unchanged. Ends with a terminal {type:"result"} event
// carrying EXACTLY what /run would have returned ({ok, text, usage, costUsd,
// exitCode, durationMs, timedOut, aborted, stderr}), so callers keep their
// result-handling logic and only gain live progress.
function runStream(res, body) {
  const prompt = body.prompt
  if (typeof prompt !== "string" || !prompt.trim()) {
    return json(res, 400, { error: "prompt_required" })
  }
  const options = body.options || {}
  // Same timeout semantics as /run: 0 = uncapped (client Terminate governs).
  const timeoutMs =
    Number(options.timeoutMs) === 0
      ? 0
      : Math.min(Math.max(Number(options.timeoutMs) || 120000, 5000), 1800000)
  const cwd =
    typeof options.workingDirectory === "string" && options.workingDirectory.trim()
      ? options.workingDirectory.trim()
      : undefined

  const args = buildArgs(prompt, options)
  // Swap the blocking `json` output for frame-per-line streaming, with partial
  // message deltas: a tool-less single-completion run (e.g. the problem
  // generator) would otherwise emit its ONE assistant frame only at the very
  // end — the exact silence this endpoint exists to kill.
  const fmtIdx = args.indexOf("--output-format")
  args[fmtIdx + 1] = "stream-json"
  args.splice(fmtIdx + 2, 0, "--verbose", "--include-partial-messages")

  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache, no-transform" })
  const send = (obj) => {
    try {
      res.write(`data: ${JSON.stringify(obj)}\n\n`)
    } catch {
      /* client gone */
    }
  }

  const start = Date.now()
  const metrics = { tools_invoked: 0, llm_invocations: 0, time_elapsed: 0 }

  let child
  try {
    child = spawn(CLAUDE_BIN, args, {
      cwd: cwd || process.cwd(),
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      env:
        Number(options.maxOutputTokens) > 0
          ? { ...process.env, CLAUDE_CODE_MAX_OUTPUT_TOKENS: String(Number(options.maxOutputTokens)) }
          : process.env,
    })
  } catch (err) {
    send({ type: "result", ok: false, text: "", exitCode: null, durationMs: 0, timedOut: false, aborted: false, stderr: `Failed to launch "${CLAUDE_BIN}": ${String(err)}` })
    res.end()
    return
  }

  let timedOut = false
  let aborted = false
  const timer =
    timeoutMs > 0
      ? setTimeout(() => {
          timedOut = true
          child.kill("SIGKILL")
        }, timeoutMs)
      : null
  // Terminate = client disconnect kills claude, same contract as /run.
  res.on("close", () => {
    if (!res.writableEnded) {
      aborted = true
      try {
        child.kill("SIGKILL")
      } catch {
        /* gone */
      }
    }
  })

  // Liveness during silent stretches + keeps proxies from idling the socket.
  const heartbeat = setInterval(() => {
    metrics.time_elapsed = Math.round((Date.now() - start) / 1000)
    send({ type: "heartbeat", metrics })
  }, 15000)
  heartbeat.unref?.()

  // Partial-delta throttle: batch thinking/text deltas and flush at most every
  // 2s, so the console shows the model literally writing without an SSE flood.
  let pendingThinking = ""
  let pendingText = ""
  let streamedChars = 0
  let lastFlush = 0
  const flushDeltas = (force = false) => {
    const now = Date.now()
    if (!force && now - lastFlush < 2000) return
    if (!pendingThinking && !pendingText) return
    lastFlush = now
    metrics.time_elapsed = Math.round((now - start) / 1000)
    if (pendingThinking) {
      send({ type: "thinking", text: pendingThinking.slice(-2000), metrics })
      pendingThinking = ""
    }
    if (pendingText) {
      send({
        type: "message-annotation",
        subtype: "status",
        thought: `✍️ writing… (${streamedChars} chars)\n…${pendingText.slice(-300)}`,
        metrics,
      })
      pendingText = ""
    }
  }

  let buf = ""
  let stderr = ""
  let finalText = ""
  let usage = null
  let costUsd = null

  child.stdout.on("data", (chunk) => {
    buf += chunk.toString("utf8")
    let nl
    while ((nl = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, nl)
      buf = buf.slice(nl + 1)
      if (!line.trim()) continue
      let o
      try {
        o = JSON.parse(line)
      } catch {
        continue
      }
      metrics.time_elapsed = Math.round((Date.now() - start) / 1000)
      if (o.type === "result") {
        finalText = String(o.result || "").slice(0, MAX_OUTPUT_BYTES)
        if (typeof o.total_cost_usd === "number") costUsd = o.total_cost_usd
        if (o.usage) usage = o.usage
      } else if (o.type === "system" && (o.subtype === "init" || o.model)) {
        send({ type: "system", model: o.model, metrics })
      } else if (o.type === "stream_event") {
        // Token-level deltas (--include-partial-messages): the ONLY live signal
        // during a long single completion. Batched via flushDeltas above.
        const ev = o.event
        if (ev?.type === "content_block_delta") {
          if (ev.delta?.type === "thinking_delta" && ev.delta.thinking) {
            pendingThinking += ev.delta.thinking
            streamedChars += ev.delta.thinking.length
          } else if (ev.delta?.type === "text_delta" && ev.delta.text) {
            pendingText += ev.delta.text
            streamedChars += ev.delta.text.length
          }
          flushDeltas()
        }
      } else if (o.type === "assistant" && o.message?.content) {
        // Full frames: flush any buffered deltas first so ordering reads right.
        flushDeltas(true)
        metrics.llm_invocations++
        for (const c of o.message.content) {
          if (c.type === "tool_use") {
            metrics.tools_invoked++
            const name = String(c.name || "").replace(/^mcp__[a-z0-9-]+__/i, "")
            send({
              type: "message-annotation",
              subtype: "tool_intent",
              thought: `Using ${name}`,
              tool: name,
              input: typeof c.input === "string" ? c.input : JSON.stringify(c.input),
              metrics,
            })
          }
          // Full text/thinking blocks are NOT re-emitted here: their content
          // already streamed via the deltas above — re-sending would duplicate.
        }
      } else if (o.type === "user" && o.message?.content) {
        for (const c of o.message.content) {
          if (c.type === "tool_result") {
            const t = Array.isArray(c.content)
              ? c.content.map((x) => x.text || "").join("\n")
              : String(c.content ?? "")
            send({ type: "message-annotation", subtype: "tool_result", thought: "Tool output", output: t.slice(0, 8000), metrics })
          }
        }
      }
    }
  })

  child.stderr.on("data", (c) => {
    stderr += c.toString("utf8")
  })
  child.on("error", (err) => {
    if (timer) clearTimeout(timer)
    clearInterval(heartbeat)
    send({ type: "result", ok: false, text: "", exitCode: null, durationMs: Date.now() - start, timedOut: false, aborted: false, stderr: `Failed to launch "${CLAUDE_BIN}": ${err.message}` })
    res.end()
  })
  child.on("close", (code) => {
    if (timer) clearTimeout(timer)
    clearInterval(heartbeat)
    flushDeltas(true)
    metrics.time_elapsed = Math.round((Date.now() - start) / 1000)
    send({
      type: "result",
      ok: code === 0 && !timedOut && !aborted,
      text: finalText,
      usage,
      costUsd,
      exitCode: code,
      durationMs: Date.now() - start,
      timedOut,
      aborted,
      stderr: stderr.slice(0, 4000),
      metrics,
    })
    res.end()
  })
}

function getVersion() {
  return new Promise((resolve) => {
    let out = ""
    let err = ""
    let child
    try {
      child = spawn(CLAUDE_BIN, ["--version"], { shell: false })
    } catch (e) {
      resolve({ ok: false, version: "", error: String(e) })
      return
    }
    const timer = setTimeout(() => child.kill("SIGKILL"), 15000)
    child.on("error", (e) =>
      resolve({ ok: false, version: "", error: `Failed to launch "${CLAUDE_BIN}": ${e.message}` }),
    )
    child.stdout?.on("data", (c) => (out += c))
    child.stderr?.on("data", (c) => (err += c))
    child.on("close", (code) => {
      clearTimeout(timer)
      resolve({ ok: code === 0, version: out.trim(), error: code === 0 ? "" : err.trim() })
    })
  })
}

// ---------------------------------------------------------------------------
// /prove — the new architecture. Hand Claude the Lean MCP tools and let its own
// agent loop iterate (tool → verify → error → retry) until verify_full_script
// confirms a proof of the stated theorem, then return that proof.
// ---------------------------------------------------------------------------
function buildMcpConfig(mcpServers) {
  const servers = {}
  for (const s of mcpServers || []) {
    if (s && s.name && s.url) servers[s.name] = { type: "sse", url: s.url }
  }
  return { mcpServers: servers }
}

// The current toolchain (Lean 4.29.1 + recent Mathlib) REMOVED the legacy
// big-operator `in` binder notation (`∑ x in s, …`) in favour of `∈`, so a
// theorem written with `in` fails to even PARSE ("unexpected token 'in'"). Many
// ACG-generated problems still use `in`. Normalize it to `∈` (identical meaning)
// up front so the WHOLE pipeline — the agent's attempts, the drift guard, and the
// gates — operate on syntax the compiler actually accepts. Only ` in ` that
// follows a big-operator symbol is touched; `a ∈ s`, `let … in`, etc. are left
// alone.
function normalizeProblemSyntax(src) {
  return String(src == null ? "" : src).replace(/([∑∏⨆⨅⋃⋂⨁⨂][^,\n]*?)\s+in\s+/g, "$1 ∈ ")
}

// ===========================================================================
// SEARCH GOVERNOR — forcible "hack, don't search" throttle
// ---------------------------------------------------------------------------
// The prover kept burning turns on loogle/moogle instead of compiling. To make
// search EARNED, we ration it: the bridge hosts a governed MCP proxy of the
// search server (Leak I). Each subagent run's MCP config points its search tools
// at the bridge itself (127.0.0.1) instead of Leak I; the bridge forwards a call
// only while the run has search budget, and otherwise returns a message telling
// the agent to prove instead. Budget starts small and is refilled ONLY when
// verify_full_script reports a SYNTAX error (an unknown name / parse error) —
// the one situation where a lookup actually helps. Verify + Pantograph are never
// throttled (those are hacking, not searching).
// ---------------------------------------------------------------------------
const SEARCH_TOOL_RE = /loogle|moogle|search/i
const isSearchToolName = (n) => SEARCH_TOOL_RE.test(String(n || ""))
// A verify failure worth a search grant: the compiler didn't understand a NAME
// or the syntax — as opposed to a type/logic error, which a lookup won't fix.
const SYNTAX_ERR_RE =
  /unknown (identifier|constant|package|namespace|tactic)|unexpected token|unexpected end|unterminated|unexpected identifier|expected |has not been declared|invalid field notation/i
function verifyTextIsSyntaxError(text) {
  const raw = String(text == null ? "" : text)
  if (!/failed|❌|error/i.test(raw)) return false
  const p = parseVerifyOutput(raw)
  if (p.errors.some((e) => SYNTAX_ERR_RE.test(e.message))) return true
  // Leak IV results arrive as a JSON string whose diagnostics are on escaped
  // "\n"s, so the per-line parse above can miss them; fall back to the raw text
  // (the regex has no line anchors). Without this the refill NEVER fired.
  return SYNTAX_ERR_RE.test(raw)
}
// A "probe" verify is one whose entire body is name/existence checks
// (#check / #print / #eval / #find, or `example : T := @name`) with no real
// proof. Probing is how the agent brute-forces lemma NAMES in the unmetered
// compiler channel — it must NOT earn a search refill, or we'd be paying it to
// guess. A script with a theorem/lemma/have or a `by` tactic block is a genuine
// attempt and DOES earn a refill when it hits a truly unknown name.
function isRealProofScript(script) {
  const s = String(script || "")
  return /\b(theorem|lemma|have|show|suffices)\b/.test(s) || /:=\s*by\b/.test(s)
}

const GOV_INITIAL = Number(process.env.SEARCH_BUDGET_INITIAL || 3)
const GOV_GRANT = Number(process.env.SEARCH_BUDGET_GRANT || 3)
const governors = new Map() // id -> governor
let govSeq = 0

function createGovernor({ initial } = {}) {
  const id = `${(++govSeq).toString(36)}${randomBytes(4).toString("hex")}`
  const g = {
    id,
    budget: Number.isFinite(initial) ? initial : GOV_INITIAL,
    searchServer: null, // { url, tools: [{ name, argKey }] } — the upstream we proxy
    sessions: new Map(), // sseSessionId -> res
    searchCount: 0,
    grantCount: 0,
    blockedCount: 0,
    // Bridge-served tools: name -> { description, inputSchema, run(args) }. Used by
    // the Claude-driven architect (Leak Ultra) so the CLI's tool calls execute in
    // the bridge — same executors, same gates as the Grok loop — instead of the CLI
    // talking to Leak XII/XIV directly, where the bridge could not see the results.
    handlers: new Map(),
  }
  governors.set(id, g)
  return g
}
function destroyGovernor(g) {
  if (!g) return
  for (const res of g.sessions.values()) {
    try {
      res.end()
    } catch {
      /* gone */
    }
  }
  governors.delete(g.id)
}
function grantSearch(g, why) {
  if (!g) return
  g.budget += GOV_GRANT
  g.grantCount++
}

// Build an MCP config where any PURE search server (all its tools are searches,
// e.g. Leak I) is redirected through this run's governor; everything else stays
// direct. Records the upstream on the governor so it can proxy allowed calls.
function buildGovernedMcpConfig(mcpServers, governor) {
  const servers = {}
  for (const s of mcpServers || []) {
    if (!s || !s.name || !s.url) continue
    const tools = (Array.isArray(s.tools) ? s.tools : [])
      .map((t) => (typeof t === "string" ? { name: t } : t))
      .filter((t) => t && t.name)
    const searchTools = tools.filter((t) => isSearchToolName(t.name))
    if (governor && searchTools.length && searchTools.length === tools.length) {
      // Pure search server -> govern it.
      governor.searchServer = {
        url: s.url,
        tools: searchTools.map((t) => ({
          name: t.name,
          argKey: (Array.isArray(t.args) && t.args[0]) || "query",
        })),
      }
      servers[s.name] = { type: "sse", url: `http://127.0.0.1:${PORT}/gov/${governor.id}/sse` }
      console.log(`[gov ${governor.id}] governing "${s.name}" search (budget ${governor.budget}) -> ${s.url}`)
    } else {
      servers[s.name] = { type: "sse", url: s.url }
    }
  }
  // Bridge-served tools get their own entry so the CLI can reach the architect
  // executors. Named "architect" so tools surface as mcp__architect__lean_compile.
  if (governor?.handlers?.size)
    servers.architect = { type: "sse", url: `http://127.0.0.1:${PORT}/gov/${governor.id}/sse` }
  return { mcpServers: servers }
}

// The governor's response to a search tools/call: forward while in budget, else
// return the "go prove instead" message so the agent SEES why it was refused.
async function governedSearchCall(g, toolName, args) {
  g.searchCount++
  if (g.budget <= 0) {
    g.blockedCount++
    console.log(`[gov ${g.id}] search BLOCKED (budget 0) tool=${toolName}`)
    return `🛑 Search budget spent — stop searching and PROVE. You already know Lean 4; lead with strong automation (decide / native_decide / omega / simp / nlinarith / induction) and call verify_full_script. To resolve a specific lemma NAME, do NOT guess it with \`#check @name\` — put the goal in \`example : <goal> := by exact?\` (or apply?/rw?/simp?); unification finds the name for free. A search allowance is earned only when a REAL proof attempt hits an unknown name. If the goal is genuinely too big, decompose it.`
  }
  g.budget--
  const srv = g.searchServer
  if (!srv?.url) return "Search is unavailable right now — prove with the compiler and interactive tactics instead."
  console.log(`[gov ${g.id}] search forwarded tool=${toolName} (${g.budget} left)`)
  // Every legitimate loogle/moogle query returns in well under this; loogle's own
  // heartbeat guard errors a too-broad one in ~15-20s. So 25s covers all real
  // cases and cuts losses fast on a stuck one — and since Leak-I no longer drops
  // its warm index on a timeout, abandoning early here is now harmless.
  const r = await callRemoteMcpTool(srv.url, toolName, args, { timeoutMs: 25000 })
  const body = r.ok ? r.text : `Search error: ${r.error || "unknown"} — don't retry; prove with the compiler instead.`
  return `${body}\n\n[search budget: ${g.budget} left — spend it on TYPE-PATTERN loogle queries (e.g. loogle "(f _)^[_] _ = _") or moogle concepts, never on a bare lemma name. To resolve a name for free, use \`exact?\`/\`apply?\` in a script. Prefer compiling.]`
}

// ---- MCP-over-SSE SERVER for the governor (the inverse of callRemoteMcpTool) --
// The claude CLI connects here as if to a normal SSE MCP server: GET opens the
// stream and we advertise a POST endpoint; POSTed JSON-RPC replies go back over
// the stream. We expose only the upstream's search tools, gated by the budget.
function governorSse(req, res, govId) {
  const g = governors.get(govId)
  if (!g) {
    res.writeHead(404)
    res.end()
    return
  }
  const sid = randomBytes(8).toString("hex")
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
  })
  g.sessions.set(sid, res)
  res.write(`event: endpoint\ndata: /gov/${govId}/message?sessionId=${sid}\n\n`)
  const ka = setInterval(() => {
    try {
      res.write(`: keep-alive\n\n`)
    } catch {
      /* gone */
    }
  }, 15000)
  req.on("close", () => {
    clearInterval(ka)
    g.sessions.delete(sid)
  })
}

async function governorMessage(req, res, govId, sid) {
  const g = governors.get(govId)
  const stream = g && g.sessions.get(sid)
  const raw = await readBody(req)
  res.writeHead(202)
  res.end()
  if (!g || !stream) return
  let msg
  try {
    msg = JSON.parse(raw)
  } catch {
    return
  }
  const reply = (result) => {
    try {
      stream.write(`data: ${JSON.stringify({ jsonrpc: "2.0", id: msg.id, result })}\n\n`)
    } catch {
      /* gone */
    }
  }
  const method = msg.method
  if (method === "initialize") {
    reply({
      protocolVersion: msg.params?.protocolVersion || "2024-11-05",
      capabilities: { tools: {} },
      serverInfo: { name: "leak-search-governor", version: "1.0.0" },
    })
  } else if (method === "notifications/initialized") {
    /* notification — no reply */
  } else if (method === "ping") {
    reply({})
  } else if (method === "tools/list") {
    const tools = (g.searchServer?.tools || []).map((t) => ({
      name: t.name,
      description:
        "Mathlib library search. RATIONED to force compiler-driven proving: prefer writing a proof and reading verify_full_script errors. Use only when you need a specific unknown lemma NAME.",
      inputSchema: {
        type: "object",
        properties: { [t.argKey]: { type: "string", description: "search query" } },
        required: [t.argKey],
      },
    }))
    for (const [name, h] of g.handlers)
      tools.push({ name, description: h.description || name, inputSchema: h.inputSchema || { type: "object", properties: {} } })
    reply({ tools })
  } else if (method === "tools/call") {
    const name = msg.params?.name
    const h = g.handlers.get(name)
    if (h) {
      // Bridge-served tool (architect stage executor). Errors come back as tool
      // TEXT, never as a JSON-RPC error: the driver has to be able to read and
      // react to a failure the same way it reads a compile report.
      let text
      try {
        text = await h.run(msg.params?.arguments || {})
      } catch (e) {
        text = `Tool error: ${String(e?.message || e)}`
      }
      reply({ content: [{ type: "text", text: String(text ?? "") }] })
    } else {
      const text = await governedSearchCall(g, name, msg.params?.arguments || {})
      reply({ content: [{ type: "text", text }] })
    }
  } else if (msg.id != null) {
    reply({})
  }
}

// --- Target-theorem gate ----------------------------------------------------
// The user's input is always the bare theorem signature proven by `sorry`
// (e.g. `theorem foo (n : ℕ) : P n := by sorry`). A verify_full_script success
// only counts as a real proof if the compiled script actually contains THAT
// theorem (same signature) — not just a helper `example`/lemma that happens to
// compile. Whether the proof is genuinely complete is the TOOLCHAIN's job to
// decide (verify_full_script); we do not second-guess it with string checks.

// Collapse whitespace so trivial reformatting doesn't break the comparison.
function normalizeLean(s) {
  return String(s == null ? "" : s).replace(/\s+/g, " ").trim()
}

// Canonical form of a signature for IMMUTABILITY comparison. The agent re-types
// the target signature when it writes a proof/decomposition, and a single
// incidental spacing difference around an operator (`(2:ℤ)^m` vs `(2 : ℤ) ^ m`,
// `∑ i, v i^2` vs `∑ i, v i ^ 2`, `{v :` vs `{ v :`) must NOT be treated as a
// different statement — on a notation-heavy signature that mismatch is almost
// guaranteed and was silently rejecting valid proofs. We drop whitespace EXCEPT
// between two "word" characters (identifiers/numbers/greek/subscripts), so token
// boundaries are preserved: this tolerates formatting but can never alias two
// genuinely different Lean statements (their token streams still differ).
const _isWordChar = (c) => c != null && /[\p{L}\p{N}_]/u.test(c)
function canonicalSig(s) {
  const collapsed = String(s == null ? "" : s).replace(/\s+/g, " ").trim()
  let out = ""
  for (let i = 0; i < collapsed.length; i++) {
    const ch = collapsed[i]
    if (ch === " ") {
      if (_isWordChar(out[out.length - 1]) && _isWordChar(collapsed[i + 1])) out += " "
    } else {
      out += ch
    }
  }
  return out
}

// Extract a declaration's signature: everything from the `theorem`/`lemma`
// keyword up to (but not including) the `:=` that begins the proof, canonically
// normalized so incidental formatting doesn't break the comparison. Returns ""
// if no such declaration is found.
function theoremSignature(src) {
  const m = String(src == null ? "" : src).match(/\b(?:theorem|lemma)\b[\s\S]*?(?=:=)/)
  return m ? canonicalSig(m[0]) : ""
}

// True if `script` contains a theorem/lemma whose signature equals targetSig.
// Scans every declaration in the script (a proof may define helper lemmas too).
function scriptProvesTarget(script, targetSig) {
  if (!targetSig) return false
  const re = /\b(?:theorem|lemma)\b[\s\S]*?(?=:=)/g
  let m
  while ((m = re.exec(script)) !== null) {
    if (canonicalSig(m[0]) === targetSig) return true
  }
  return false
}

// True iff a verify_full_script tool result reports a genuine success. Verified
// LIVE against the Leak II daemon (barkingtree-leak-ii.hf.space): a real proof
// returns "✅ Compilation Successful! The proof is 100% verified.", while ANY
// hole — bare `sorry`, `admit`, or a `sorry` inside a helper lemma — returns
// "❌ Compilation Failed: … declaration uses `sorry`". So the daemon itself is
// the first line of defence; we accept ONLY on the success phrase and never when
// a failure/❌ marker is present (guards the "❌ … no goals" false-positive too).
function verifyResultSucceeded(text) {
  const t = String(text == null ? "" : text)
  return /compilation successful|100% verified/i.test(t) && !/compilation failed|❌/i.test(t)
}

// The ONE proof gate, shared by BOTH the streaming path (/prove-stream, ACG) and
// the worker path (runProve → customer traffic) so they can never diverge. Feed
// it every parsed stream-json object; it records the FIRST verify_full_script
// script that (a) the toolchain confirmed successful AND (b) contains the target
// theorem signature. `verifiedScript` is the single source of truth for "is it
// proved" — an unverified run yields null, i.e. the customer is not charged and
// the ACG problem is not promoted. The soundness of "confirmed successful" is
// entirely the toolchain's responsibility; this gate does not re-judge it.
function makeProofGate(theorem) {
  const verifyCalls = {}
  let verifiedScript = null
  const targetSig = theoremSignature(theorem)
  const gateAccepts = (script) =>
    targetSig ? scriptProvesTarget(script, targetSig) : true

  // Returns a small event describing what this object caused, so a streaming
  // caller can surface it: { verified } on acceptance, { rejected } on a compile
  // that didn't match the target, or null when nothing notable happened.
  function observe(o) {
    if (o.type === "assistant" && o.message?.content) {
      for (const c of o.message.content) {
        if (
          c.type === "tool_use" &&
          String(c.name || "").endsWith("verify_full_script") &&
          c.input &&
          typeof c.input === "object" &&
          typeof c.input.script === "string"
        ) {
          verifyCalls[c.id] = c.input.script
        }
      }
    } else if (o.type === "user" && o.message?.content) {
      for (const c of o.message.content) {
        if (c.type !== "tool_result") continue
        const t = Array.isArray(c.content)
          ? c.content.map((x) => x.text || "").join("\n")
          : String(c.content ?? "")
        if (
          !verifiedScript &&
          c.tool_use_id &&
          verifyCalls[c.tool_use_id] &&
          verifyResultSucceeded(t)
        ) {
          const okScript = verifyCalls[c.tool_use_id]
          if (gateAccepts(okScript)) {
            verifiedScript = okScript
            return { verified: okScript }
          }
          return { rejected: okScript }
        }
      }
    }
    return null
  }

  return {
    observe,
    get verifiedScript() {
      return verifiedScript
    },
  }
}

// ===========================================================================
// PROOF-TREE DECOMPOSITION (Phase 2 + 3)
// ---------------------------------------------------------------------------
// When the agent "eternally theorises" and never closes a goal, we STOP letting
// one run wander forever. A node is proved directly with a bounded turn budget;
// if it stalls (or the agent asks), the focus shifts ENTIRELY to breaking the
// node's goal into smaller EQUIVALENT sub-lemmas — recursively — until every
// leaf is genuinely closed, then we assemble bottom-up and gate the whole thing
// on ONE final sorry-free compile.
//
// Two invariants make this sound:
//   1. Signatures are IMMUTABLE. The orchestrator owns every node's statement;
//      a subagent may only add helper lemmas / write proof bodies, never edit a
//      statement. Enforced by scriptProvesTarget (the exact signature must be
//      present in what the subagent returns).
//   2. Decompositions are VERIFIED, not trusted. A proposed decomposition is
//      accepted ONLY if the toolchain, compiling the scaffold, reports that its
//      sole diagnostics are `sorry` warnings on the stubbed helpers — i.e. the
//      node's proof genuinely type-checks GIVEN the helpers (no real errors).
//      This is the one place a `sorry` warning is a FEATURE, and the whole gate
//      is derived purely from the daemon's own verify_full_script text.
// ---------------------------------------------------------------------------

// Parse the Leak daemon's verify_full_script text into a structured verdict.
// Success => "✅ Compilation Successful!"; failure => "❌ Compilation Failed:"
// followed by "Line N (Error|Warning): message" lines (a `sorry`/`admit`
// surfaces as a Warning "declaration uses `sorry`").
const SORRY_RE = /uses\s*[`'"]?\s*(sorry|admit)/i
// Verify results frequently arrive as the daemon's JSON envelope
// {"result":"…\n…"} where the newlines are ESCAPED. The per-line diagnostic
// regex below is line-anchored (^Line …), so on escaped `\n` it silently finds
// NOTHING — which made the have-tree gate reject its own valid skeletons (an
// escaped "Line 3 (Warning): … sorry" parsed as zero sorry-warnings). Un-escape
// first — extract the JSON `result`, else turn literal \n/\r/\t escapes into real
// whitespace — so EVERY caller (structural gate, hole-free check, syntax-error
// check) sees the real diagnostic lines.
function normalizeVerifyText(text) {
  const s = String(text == null ? "" : text)
  const t = s.trim()
  if (t.startsWith("{") && /"result"\s*:/.test(t)) {
    try {
      const obj = JSON.parse(t)
      if (obj && typeof obj.result === "string") return obj.result
    } catch {
      /* not clean JSON — fall through to escape-unwrapping */
    }
  }
  if (!/\n/.test(s) && /\\n|\\r|\\t/.test(s)) {
    return s.replace(/\\r\\n|\\n|\\r/g, "\n").replace(/\\t/g, "\t")
  }
  return s
}

function parseVerifyOutput(text) {
  const raw = normalizeVerifyText(text)
  const success =
    /compilation successful|100% verified/i.test(raw) && !/compilation failed|❌/i.test(raw)
  const diagnostics = []
  const re = /^\s*Line\s+(\d+)\s*\((Error|Warning)\)\s*:\s*(.*)$/gim
  let m
  while ((m = re.exec(raw)) !== null) {
    diagnostics.push({ line: Number(m[1]), severity: m[2].toLowerCase(), message: m[3].trim() })
  }
  const errors = diagnostics.filter((d) => d.severity === "error")
  const warnings = diagnostics.filter((d) => d.severity === "warning")
  const sorryWarnings = warnings.filter((d) => SORRY_RE.test(d.message))
  const otherWarnings = warnings.filter((d) => !SORRY_RE.test(d.message))
  const serverError = /verification error|unexpected server error/i.test(raw)
  return { raw, success, diagnostics, errors, warnings, sorryWarnings, otherWarnings, serverError }
}

// True iff a compiled scaffold PROVES its node modulo stubbed helpers: no real
// ERRORS and ≥1 sorry (the helpers). We deliberately TOLERATE non-sorry warnings
// (deprecations like "`push_neg` has been deprecated", linter notes such as
// unused variables): those are not soundness holes and must not reject an
// otherwise-valid reduction — a real type error is severity Error, which we do
// reject. A fully-successful compile (no sorry at all) is handled by the caller
// as "already proved directly", not a decomposition.
function isStructurallyValidDecomposition(parsed) {
  return (
    !parsed.serverError &&
    !parsed.success &&
    parsed.errors.length === 0 &&
    parsed.sorryWarnings.length > 0
  )
}

// True iff a compiled script is HOLE-FREE: no errors and no `sorry`/`admit`. The
// daemon's own ✅ additionally requires zero warnings, so it rejects a correct,
// hole-free proof that merely uses a deprecated tactic. For the tree's final
// acceptance the promise is "a true, hole-free proof", so we accept hole-free
// even with benign warnings (still never with an error or a sorry).
function isHoleFreeProof(parsed) {
  return !parsed.serverError && parsed.errors.length === 0 && parsed.sorryWarnings.length === 0
}

// Heuristic top-level declaration parser. Declarations start at a line boundary
// (optionally after attributes like `@[simp]`); each block runs to the next
// top-level declaration or EOF. Good enough for our generated scaffolds; a
// parsing slip fails safe because the FINAL daemon verify is the real gate.
const DECL_RE = /^[ \t]*(?:@\[[^\]]*\][ \t\r\n]*)*(theorem|lemma|def|instance|abbrev|example)\b/gm
// The declared name of a `theorem`/`lemma` (up to its first binder/`:`).
function declaredName(rawStmt) {
  const m = String(rawStmt == null ? "" : rawStmt).match(/\b(?:theorem|lemma)\s+([^\s({\[:]+)/)
  return m ? m[1] : null
}
function extractDeclarations(script) {
  const src = String(script == null ? "" : script)
  const starts = []
  let m
  while ((m = DECL_RE.exec(src)) !== null) starts.push({ index: m.index, kind: m[1] })
  const decls = []
  for (let i = 0; i < starts.length; i++) {
    const from = starts[i].index
    const to = i + 1 < starts.length ? starts[i + 1].index : src.length
    const text = src.slice(from, to).trim()
    decls.push({ kind: starts[i].kind, text, signature: theoremSignature(text), name: declaredName(text) })
  }
  return decls
}

// Strip `import …` lines (the daemon injects `import Mathlib` itself).
function stripImports(script) {
  return String(script == null ? "" : script)
    .split("\n")
    .filter((l) => !/^\s*import\b/.test(l))
    .join("\n")
    .trim()
}

// Identify the master declaration in a scaffold BY NAME (robust to the agent
// renaming binders or re-spacing the statement — that drift is judged separately
// by the semantic drift guard). Falls back to a signature match.
function findMaster(decls, masterName, masterSig) {
  if (masterName) {
    const byName = decls.find((d) => d.name === masterName)
    if (byName) return byName
  }
  if (masterSig) return decls.find((d) => d.signature && d.signature === masterSig)
  return undefined
}

// Just the master declaration's text from a scaffold (helper stubs dropped —
// children supply the real proofs during assembly).
function targetDeclarationOnly(scaffold, masterName, masterSig) {
  const d = findMaster(extractDeclarations(scaffold), masterName, masterSig)
  return d ? d.text : ""
}

// The helper lemmas a scaffold introduced (every theorem/lemma but the master).
function helperDeclarations(scaffold, masterName, masterSig) {
  const decls = extractDeclarations(scaffold)
  const master = findMaster(decls, masterName, masterSig)
  return decls.filter(
    (d) => (d.kind === "theorem" || d.kind === "lemma") && d !== master && d.name !== masterName,
  )
}

// Lean requires a name to be declared BEFORE use, so a scaffold that writes the
// master first (referencing helpers below) fails purely on ordering. Rebuild it
// with helpers first (given order) and the master LAST, so the structural gate
// judges the reduction, not the author's ordering.
function normalizeScaffoldOrder(scaffold, masterName, masterSig) {
  const decls = extractDeclarations(stripImports(scaffold))
  const master = findMaster(decls, masterName, masterSig)
  if (!master) return stripImports(scaffold)
  const others = decls.filter((d) => d !== master)
  return [...others.map((d) => d.text), master.text].join("\n\n")
}

// ── semantic immutability: "did the agent drift the goal?" ───────────────────
// Rather than string-compare signatures (brittle to spacing AND binder names),
// ask the TOOLCHAIN: rename the agent's restated master to an internal name and
// re-prove the TRUE master statement from it. If the two goals are the same up
// to defeq, `exact`/`apply` closes it; if the agent drifted to a different or
// weaker goal, it errors. This is the user's construction — identical signatures
// prove each other. When the input already proves the agent's master, the result
// is itself a hole-free proof of the customer's VERBATIM theorem.
const _reEsc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
function masterStatementHead(rawStmt) {
  const s = String(rawStmt == null ? "" : rawStmt)
  const idx = s.indexOf(":=")
  return (idx >= 0 ? s.slice(0, idx) : s).trim()
}
function renameDecl(script, name, newName) {
  const re = new RegExp("(\\b(?:theorem|lemma)\\s+)" + _reEsc(name) + "\\b")
  return String(script).replace(re, "$1" + newName)
}
// Returns a script that re-proves the TRUE master from the agent's version, or
// null if the scaffold has no declaration named like the master (a drift we
// reject outright — the agent renamed or dropped the master theorem).
function buildDriftGuardScript(script, masterStatement) {
  const name = declaredName(masterStatement)
  if (!name) return null
  if (!new RegExp("\\b(?:theorem|lemma)\\s+" + _reEsc(name) + "\\b").test(script)) return null
  const renamed = renameDecl(script, name, "leakInternalTarget")
  const head = masterStatementHead(masterStatement)
  const guard = `${head} := by\n  first\n  | exact leakInternalTarget\n  | (apply leakInternalTarget <;> assumption)`
  return `${renamed}\n\n${guard}`
}

// ── disproof: show the MASTER is FALSE, machine-checked ──────────────────────
// Disproving T is just proving ¬T. For `∀ <binders>, C`, a counterexample is a
// witness w with ¬C[w]; when C[w] is Decidable (most concrete numeric goals),
// `native_decide` proves it. We build ¬(∀…, C), apply the ∀ to small witnesses,
// and `revert; native_decide` the resulting instance. If the daemon compiles it
// sorry-free, the master is refuted — a real Lean disproof. Refuting only ever
// REJECTS a problem (never accepts a proof), so it is unconditionally safe: the
// daemon must actually certify ¬T, and a mis-fire can at worst discard a problem.
const REFUTE_WITNESSES = [0, 1, 2, 3, 4, 5, 6, 8, 10, 12, 16, 20]

// `∀ <binders>, <concl>` from a theorem statement (name + `:= …` dropped).
// Returns { prop, closed } (closed = ground proposition, no binders) or null.
function masterPropOf(rawStmt) {
  const head = masterStatementHead(rawStmt) // `theorem NAME BINDERS : CONCL`
  const afterName = head
    .replace(
      /^\s*(?:@\[[^\]]*\]\s*)?(?:private\s+|protected\s+|noncomputable\s+)*(?:theorem|lemma)\s+[^\s({\[:]+/,
      "",
    )
    .trim()
  // Binders are all bracketed, so the FIRST top-level colon splits binders/concl.
  let depth = 0
  let cut = -1
  for (let i = 0; i < afterName.length; i++) {
    const c = afterName[i]
    if ("([{⟨".includes(c)) depth++
    else if (")]}⟩".includes(c)) depth--
    else if (c === ":" && depth === 0) {
      cut = i
      break
    }
  }
  if (cut < 0) return null
  const binders = afterName.slice(0, cut).trim()
  const concl = afterName.slice(cut + 1).trim()
  if (!concl) return null
  return binders ? { prop: `∀ ${binders}, ${concl}`, closed: false } : { prop: concl, closed: true }
}

// A `theorem leakRefute : ¬(prop) := by …` harness that tries the given witnesses
// (each discharging up to one leading hypothesis with a cheap tactic). null if no
// prop can be formed.
function buildRefuteScript(rawStmt, witnesses = REFUTE_WITNESSES) {
  const mp = masterPropOf(rawStmt)
  if (!mp) return null
  if (mp.closed) return `theorem leakRefute : ¬ (${mp.prop}) := by\n  native_decide`
  const attempts = []
  for (const w of witnesses) {
    attempts.push(`(have hcex := leakH ${w}; revert hcex; native_decide)`)
    attempts.push(`(have hcex := leakH ${w} (by decide); revert hcex; native_decide)`)
    attempts.push(`(have hcex := leakH ${w} (by norm_num); revert hcex; native_decide)`)
    attempts.push(`(have hcex := leakH ${w} (by omega); revert hcex; native_decide)`)
  }
  const chain = attempts.map((a) => `    | ${a}`).join("\n")
  return `theorem leakRefute : ¬ (${mp.prop}) := by\n  intro leakH\n  first\n${chain}`
}

// Pull candidate witness integers out of an agent's `REFUTE: …` line so a
// disproof it claims (possibly at a larger value than the default sweep) is tried.
function parseRefuteWitnesses(text) {
  const line = String(text || "").match(/REFUTE\s*:[^\n]*/i)?.[0] || ""
  const nums = (line.match(/-?\d{1,7}/g) || []).map(Number).filter((n) => Number.isInteger(n) && n >= 0)
  return [...new Set(nums)].slice(0, 12)
}

// Try to refute rawStmt on the daemon. Returns { refuted, script, witness } —
// refuted iff a harness compiles hole-free (a certified ¬T). On a hit it pins
// down the SMALLEST witness and returns a MINIMAL single-witness certificate
// (not the full sweep), so the stored/displayed disproof stays readable.
// The disproof probe is a fast OPTIMIZATION (catch an obviously-false theorem in
// seconds), so it gets a SHORT leash — not the full verify timeout. Some bodies
// are poison for `native_decide` (e.g. a sum over `Equiv.Perm (Fin n)` with `n`
// still symbolic): the daemon would grind toward the 180s wall for nothing. If
// the probe exceeds this, we bail and just let the prover run. Env-overridable.
const REFUTE_TIMEOUT_MS_DEFAULT = Number(process.env.REFUTE_TIMEOUT_MS || 25000)
const refuteTimeoutOf = (ctx) => ctx.refuteTimeoutMs || REFUTE_TIMEOUT_MS_DEFAULT

async function refutePreCheck(rawStmt, ctx, extraWitnesses = []) {
  if (ctx.signal?.aborted) return { refuted: false }
  const witnesses = [...new Set([...extraWitnesses, ...REFUTE_WITNESSES])]
  const script = buildRefuteScript(rawStmt, witnesses)
  if (!script) return { refuted: false }
  const timeoutMs = refuteTimeoutOf(ctx)
  const v = await verifyViaDaemon(script, ctx.verifyUrl, { timeoutMs })
  if (!(v.ok && isHoleFreeProof(parseVerifyOutput(v.text)))) {
    // Bail out loudly on a timeout so the run visibly moves on to proving.
    if (/timed out/i.test(v.error || "")) {
      ctx.emit?.({
        type: "message-annotation",
        subtype: "status",
        thought: `⏭️ Disproof pre-check exceeded ${Math.round(timeoutMs / 1000)}s (undecidable/heavy body) — skipping it and proceeding to prove.`,
      })
    }
    return { refuted: false }
  }
  const w = await findRefuteWitness(rawStmt, ctx, witnesses).catch(() => null)
  const minimal = w != null ? buildRefuteScript(rawStmt, [w]) : script
  return { refuted: true, script: minimal, witness: w }
}

// On a confirmed refute, find the SMALLEST witness (for a human-readable message).
async function findRefuteWitness(rawStmt, ctx, witnesses = REFUTE_WITNESSES) {
  const timeoutMs = refuteTimeoutOf(ctx)
  for (const w of witnesses) {
    if (ctx.signal?.aborted) break
    const s = buildRefuteScript(rawStmt, [w])
    if (!s) return null
    const v = await verifyViaDaemon(s, ctx.verifyUrl, { timeoutMs })
    if (v.ok && isHoleFreeProof(parseVerifyOutput(v.text))) return w
  }
  return null
}

// Agent-facing note (opt-in): lets the model bail out of a FALSE theorem instead
// of grinding it. Its claim is NEVER trusted — a REFUTE only triggers an
// independent daemon disproof; an unverified REFUTE just ends the run unproven.
const REFUTE_NOTE =
  "DISPROOF (optional): if you become convinced the theorem is FALSE, output a line exactly `REFUTE: <one-line reason; include the smallest counterexample value if the goal ranges over ℕ/ℤ>` and STOP — do NOT keep trying to prove a false statement. The system independently verifies any disproof on the daemon (an unverified REFUTE simply ends the run as unproven), so only use it with a concrete counterexample in mind."

// Confirm an agent's REFUTE claim by machine-checked disproof, trying the
// witnesses it named first. Returns { refuted, counterexample } (refuted only
// when the daemon certifies ¬T).
async function confirmAgentRefute(rawStmt, ctx, refuteText) {
  const witnesses = parseRefuteWitnesses(refuteText)
  const pre = await refutePreCheck(rawStmt, ctx, witnesses)
  if (!pre.refuted) return { refuted: false }
  const cex = pre.witness != null ? `counterexample at the first argument = ${pre.witness}` : "a counterexample"
  return { refuted: true, counterexample: cex, script: pre.script }
}

// Fold a proved subtree into one sorry-free script: each child's real proof
// (recursively), then this node's target-proof from the scaffold; children
// before parents so names resolve; duplicate signatures collapsed. The caller
// runs the FINAL daemon verify — that is what actually certifies the result.
function assembleNode(node) {
  const parts = []
  const push = (text) => {
    for (const d of extractDeclarations(text)) {
      if (!d.text) continue
      parts.push({ signature: d.signature || d.text, text: d.text })
    }
  }
  if (node.children && node.children.length) {
    for (const child of node.children) for (const p of assembleNode(child)) parts.push(p)
    const tgt = targetDeclarationOnly(node.scaffold || "", declaredName(node.signature), node.signature)
    if (tgt) parts.push({ signature: theoremSignature(tgt) || tgt, text: tgt })
  } else if (node.proof) {
    push(stripImports(node.proof))
  }
  return parts
}
function assembleScript(node) {
  const seen = new Set()
  const ordered = []
  for (const p of assembleNode(node)) {
    if (seen.has(p.signature)) continue
    seen.add(p.signature)
    ordered.push(p.text)
  }
  return ordered.join("\n\n")
}

// Pick the MCP server that actually exposes verify_full_script; else the first.
function resolveVerifyUrl(mcpServers) {
  const servers = (mcpServers || []).filter((s) => s && s.url)
  for (const s of servers) {
    const tools = Array.isArray(s.tools) ? s.tools : []
    const has = tools.some((t) => {
      const n = typeof t === "string" ? t : t && t.name
      return n && /verify.*full.*script|verify_full_script/i.test(n)
    })
    if (has) return s.url
  }
  return servers[0]?.url || null
}

// The interactive Pantograph server (Leak II) — the one exposing init_proof /
// apply_tactic. Used to free proof state between sequential minions, since the
// daemon's cleanup_memory is GLOBAL and can't be shared by concurrent callers.
function resolvePantographUrl(mcpServers) {
  for (const s of mcpServers || []) {
    if (!s?.url) continue
    const tools = Array.isArray(s.tools) ? s.tools : []
    const has = tools.some((t) => {
      const n = typeof t === "string" ? t : t && t.name
      return n && /init_proof|apply_tactic/i.test(n)
    })
    if (has) return s.url
  }
  return null
}

// Call ANY tool on a remote MCP-SSE server, one-shot. `toolMatch` is a string
// (exact tool name) or RegExp (matched against the server's tool names). Returns
// { ok, text, error }. Used both to verify scaffolds on the daemon and to proxy
// governed search calls to Leak I.
function callRemoteMcpTool(sseUrl, toolMatch, args, { timeoutMs = 180000 } = {}) {
  return new Promise((resolve) => {
    let base
    try {
      base = new URL(sseUrl)
    } catch {
      resolve({ ok: false, text: "", error: `bad mcp url: ${sseUrl}` })
      return
    }
    const origin = `${base.protocol}//${base.host}`
    let postUrl = null
    let settled = false
    let reader = null
    const pending = new Map()
    let buf = ""
    let nextId = 1
    // Own the connection lifecycle with an AbortController so WE tear the socket
    // down cleanly on success/timeout. reader.cancel() alone is not enough: it is
    // skipped if the reader hasn't been assigned yet (timeout before connect), and
    // it doesn't reliably abort the underlying undici request. A leaked request
    // gets reset later by the remote (e.g. a sleeping HF Space), and undici then
    // raises an unhandled "terminated" rejection with nothing awaiting it — which
    // crashes the whole bridge. Aborting routes that teardown into handled paths.
    const ac = new AbortController()
    const done = (out) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      // Abort the underlying request(s). This errors the SSE body stream, whose
      // reader loop already swallows the resulting AbortError (.catch below), and
      // aborts any in-flight POST (awaited inside the try/catch). Do NOT also call
      // reader.cancel() here: cancelling an already-aborted stream returns a
      // REJECTED promise (AbortError) that a synchronous try/catch cannot catch,
      // which was leaking as an unhandledRejection.
      try {
        ac.abort()
      } catch {
        /* ignore */
      }
      resolve(out)
    }
    const timer = setTimeout(
      () => done({ ok: false, text: "", error: `mcp call timed out after ${timeoutMs}ms` }),
      timeoutMs,
    )
    const handle = (evt, data) => {
      if (evt === "endpoint") {
        try {
          postUrl = new URL(data, origin).toString()
        } catch {
          postUrl = origin + data
        }
        return
      }
      let msg
      try {
        msg = JSON.parse(data)
      } catch {
        return
      }
      if (msg.id != null && pending.has(msg.id)) {
        const { resolve: r } = pending.get(msg.id)
        pending.delete(msg.id)
        r(msg)
      }
    }
    const rpc = async (method, params, { notify = false } = {}) => {
      const startWait = Date.now()
      while (!postUrl) {
        if (Date.now() - startWait > timeoutMs) throw new Error("no endpoint from daemon")
        await new Promise((r) => setTimeout(r, 50))
      }
      const id = notify ? undefined : nextId++
      const body = { jsonrpc: "2.0", method, ...(params ? { params } : {}) }
      if (!notify) body.id = id
      const p = notify ? Promise.resolve() : new Promise((r) => pending.set(id, { resolve: r }))
      const res = await fetch(postUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: ac.signal,
      })
      if (!res.ok && !notify) throw new Error(`POST ${method} -> ${res.status}`)
      return p
    }
    ;(async () => {
      try {
        const res = await fetch(sseUrl, { headers: { Accept: "text/event-stream" }, signal: ac.signal })
        if (!res.ok || !res.body) throw new Error(`SSE open failed: ${res.status}`)
        reader = res.body.getReader()
        const dec = new TextDecoder()
        ;(async () => {
          while (true) {
            const { done: rdone, value } = await reader.read()
            if (rdone) break
            buf += dec.decode(value, { stream: true }).replace(/\r\n/g, "\n")
            let idx
            while ((idx = buf.indexOf("\n\n")) !== -1) {
              const chunk = buf.slice(0, idx)
              buf = buf.slice(idx + 2)
              let evt = "message"
              const dataLines = []
              for (const line of chunk.split("\n")) {
                if (line.startsWith("event:")) evt = line.slice(6).trim()
                else if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart())
              }
              if (dataLines.length) handle(evt, dataLines.join("\n"))
            }
          }
        })().catch(() => {})
        await rpc("initialize", {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "leak-orchestrator", version: "0.1.0" },
        })
        await rpc("notifications/initialized", undefined, { notify: true })
        const list = await rpc("tools/list", {})
        const tools = list?.result?.tools || []
        const tool =
          typeof toolMatch === "string"
            ? tools.find((t) => t.name === toolMatch) || tools.find((t) => String(t.name).endsWith(toolMatch))
            : tools.find((t) => toolMatch.test(t.name))
        if (!tool) throw new Error(`tool not found on server: ${toolMatch}`)
        const r = await rpc("tools/call", { name: tool.name, arguments: args || {} })
        if (r?.error) throw new Error(`mcp RPC error: ${JSON.stringify(r.error)}`)
        const c = r?.result?.content
        const text = Array.isArray(c)
          ? c.map((x) => x?.text ?? "").join("\n")
          : JSON.stringify(r?.result ?? r)
        done({ ok: true, text })
      } catch (e) {
        done({ ok: false, text: "", error: String(e?.message || e) })
      }
    })()
  })
}

// Compile a script against the verify daemon DIRECTLY over MCP-SSE. The
// orchestrator does not trust the agent's own verify calls for scaffolds/
// assemblies IT constructs — it checks them itself.
// A verify result that reflects the DAEMON hiccupping — its Lean file worker
// aborted (native stack overflow) and it self-healed, or a socket blip — NOT the
// proof being wrong. The verdict is meaningless, so it's worth one retry: on a
// shared daemon another client's monster script can leave the worker mid-respawn,
// and the retried verify lands on the fresh worker. Kept deliberately tight so a
// genuine "Compilation Failed: Line N (Error)" is NEVER mistaken for transient.
function isTransientDaemonError(res) {
  if (!res) return true // no result at all — treat as transient
  const t = `${res.text || ""}\n${res.error || ""}`
  if (/compilation failed/i.test(t) && /Line\s+\d+\s*\(Error/i.test(t)) return false
  return (
    /worker crashed|self-healed|native stack overflow|-329(0[02])\b|Server process for .*crash|mcp call timed out|terminated|socket|ECONNRESET|network/i.test(
      t,
    ) || res.ok === false
  )
}

// Independent re-verification on the daemon, with a bounded retry when the daemon
// (not the proof) is the problem — see isTransientDaemonError. The retried call
// absorbs the fresh worker's ~Mathlib re-import, so no long fixed sleep is needed;
// a short backoff just lets the daemon's didClose/respawn settle.
async function verifyViaDaemon(script, sseUrl, { timeoutMs = 180000, retries = 1, backoffMs = 3000 } = {}) {
  let res
  for (let attempt = 0; ; attempt++) {
    res = await callRemoteMcpTool(sseUrl, /verify.*full.*script|verify_full_script/i, { script }, { timeoutMs })
    if (attempt >= retries || !isTransientDaemonError(res)) return res
    await new Promise((r) => setTimeout(r, backoffMs))
  }
}

// Build the "how to load your deferred MCP tools" section shared by the prover
// and the decomposer prompts. Claude Code prefixes MCP tools as
// mcp__<server>__<tool> (server name sanitized, e.g. "Leak II" -> "Leak_II") and
// DEFERS them: a tool can't be called until loaded with ONE ToolSearch select.
// We build the exact id list from the LIVE inventory so the agent can't invent
// an id. Verified against the live CLI: telling it to "call directly" fails with
// "No such tool available".
function mcpToolSection(mcpServers = []) {
  const sanitize = (n) => String(n || "").replace(/[^a-zA-Z0-9_]/g, "_")
  const servers = (mcpServers || []).filter((s) => s && s.name)
  const toolIds = []
  const toolLines = []
  for (const s of servers) {
    const prefix = sanitize(s.name)
    for (const t of Array.isArray(s.tools) ? s.tools : []) {
      const tn = typeof t === "string" ? t : t && t.name
      if (!tn) continue
      const id = `mcp__${prefix}__${tn}`
      toolIds.push(id)
      const args =
        t && Array.isArray(t.args) && t.args.length ? ` — args: { ${t.args.join(", ")} }` : ""
      toolLines.push(`- ${id}${args}`)
    }
  }
  if (toolIds.length) {
    return `Your Lean tools are provided over MCP but are DEFERRED — you MUST load a tool before you can call it. As your VERY FIRST action, make ONE ToolSearch call to load them all:

  ToolSearch  query: "select:${toolIds.join(",")}"

After that they are callable by these EXACT names (never invent a name):
${toolLines.join("\n")}

If ToolSearch returns nothing for a given id, that tool's server isn't connected right now — proceed with whichever loaded. If verify_full_script fails to load, say so explicitly and stop; do not fake a verification.`
  }
  if (servers.length) {
    const prefixes = servers.map((s) => sanitize(s.name))
    return `Your Lean tools are provided over MCP by these servers: ${prefixes.join(", ")}. They are DEFERRED, so load them first with ONE ToolSearch call before calling any:

  ToolSearch  query: "select:${prefixes.map((p) => `mcp__${p}__verify_full_script`).join(",")},${prefixes.map((p) => `mcp__${p}__moogle_search`).join(",")},${prefixes.map((p) => `mcp__${p}__loogle_search`).join(",")},${prefixes.map((p) => `mcp__${p}__init_proof`).join(",")},${prefixes.map((p) => `mcp__${p}__apply_tactic`).join(",")}"

Only the ids that actually exist will load; use those. Never invent a server name. If verify_full_script does not load on any server, say so and stop.`
  }
  return 'Load your Lean MCP tools first with ToolSearch "select:mcp__<server>__<tool>" (they are deferred), then use a whole-script compiler (verify_full_script) and library search.'
}

// Shared guidance that dissolves the two pathologies we keep seeing burn whole
// runs on HARD theorems: (1) the agent brute-forces a lemma NAME with
// `#check @guess` / `example : Nat := @guess` in the unmetered compiler (the
// "soft override" of the search budget), and (2) it FINDS the right lemma but
// never applies it. This does NOT relax the "go PROVE" pressure — it redirects
// name-discovery to the tools that actually resolve names, for free.
const SEARCH_USAGE_NOTE = `FINDING & USING LEMMAS — do this instead of guessing names:
- Do NOT hunt a lemma NAME with \`#check @guessedName\` or \`example : Nat := @guessedName\`. Guessing names in the compiler wastes the run and earns you nothing.
- To get the exact name of a lemma that closes a goal, let unification find it: \`example : <goal> := by exact?\` (or \`apply?\`, \`rw?\`, \`simp?\`). THAT is the name search, and it costs no search budget.
- loogle takes a TYPE PATTERN or a list of constants, never a lemma name: e.g. \`loogle "(fwdDiff _)^[_] _ _ = _"\` or \`loogle Nat.choose, Finset.sum, (_ ^ _)\`. A bare name like \`loogle "fwdDiff_iter_eq_shift"\` always errors.
- The MOMENT you have a plausible lemma — from search, from \`exact?\`, or from memory — USE it in a real script: \`simpa using <lemma> …\`, \`rw [<lemma>]\`, \`exact <lemma> …\`. If the name is slightly off, the compiler's "unknown identifier — did you mean …?" corrects it in one step. Never collect lemmas you don't apply.
- Stay in ONE workspace: drive the proof through verify_full_script. Use init_proof/apply_tactic only to LOOK at a stuck goal, ONE tactic per call (no \`;\`-chains, no \`rename'\` — Pantograph rejects them).`

// The goal is to let Claude use the tools logically on its own — but a bare
// "prove this" makes it fall into an endless moogle/loogle syntax-search spiral
// on hard theorems and never actually build or check a proof. So we hand it an
// explicit, verification-first workflow: draft → verify_full_script → iterate,
// with library search as a *subordinate* step, not the main loop. `extra` lets
// the tree append a node-specific note (e.g. the voluntary-DECOMPOSE option).
function provePrompt(theorem, mcpServers = [], extra = "") {
  const toolSection = mcpToolSection(mcpServers)

  return `You are a Lean 4 + Mathlib power user proving the theorem below. You already KNOW Lean 4 and a great deal of Mathlib. Prove by HACKING: write real Lean and let the compiler's errors drive you. Do NOT research the library first — that is a trap that wastes your turns.

${toolSection}

MINDSET: The compiler is your teacher, not the search index. Strong automation closes most goals — reach for it before any lemma hunt:
- Decidable/finite goals: \`decide\`, \`native_decide\` (great for bounded integer/ZMod checks), \`Finset\`/\`Fintype\` card computations.
- Arithmetic / linear / nonlinear: \`omega\`, \`linarith\`, \`nlinarith [sq_nonneg _, …]\`, \`positivity\`, \`ring\`, \`field_simp\`.
- Simplification / rewriting: \`simp\`, \`simp only [...]\`, \`norm_num\`, \`push_cast\`, \`gcongr\`.
- Case analysis / induction: \`fin_cases\`, \`interval_cases\`, \`rcases\`/\`obtain\`, \`induction\`, \`Nat.strong_induction_on\`.
- Reductions: cast to \`ZMod n\` and \`decide\` for parity/mod facts; build an \`Equiv\` and use \`Nat.card_congr\` for counting.
Try the one-liner your instinct suggests FIRST (\`by decide\`, \`by omega\`, \`by simp\`, \`by nlinarith [...]\`) — you will be right far more often than you expect, and a failed attempt's error is worth more than any search.

TOOLS, in order of how much you should use them:
- verify_full_script — your MAIN loop and the SOURCE OF TRUTH. Compile a whole script; read the errors; fix; recompile. Live here.
- init_proof + apply_tactic — step a goal ONE tactic at a time to SEE the exact goal state when an error is opaque or a signature is fiddly. Use these to understand a goal, not to browse.
- moogle_search / loogle_search — a LAST resort, only when the compiler tells you a specific NAME is unknown and you can't recall it. Never search to "explore" or before your first compile. Searching is slow and usually the wrong move; a good guess + the compiler beats it.

WORKFLOW:
0. Load the tools (ToolSearch select, as above). Mandatory, first.
1. IMMEDIATELY write a full candidate proof from your own knowledge (replace \`sorry\`) and call verify_full_script. Your very first tool call after loading should be verify_full_script — NOT a search. Lead with strong automation.
2. Read the errors and fix the script; recompile. Repeat. When an error is opaque or a subgoal is intricate, step through it with init_proof/apply_tactic to see the real goal state, then fold what worked back in.
3. ONLY if the compiler reports an UNKNOWN IDENTIFIER you cannot recall, do one quick search for that exact name — then get straight back to compiling. Do not chain searches.
4. If a tool errors or hangs, don't retry in a loop — change tactic and keep compiling.
5. Done ONLY when verify_full_script reports success on a script containing the ORIGINAL theorem below (same name and signature) with no \`sorry\`. Output that final verified proof as a single \`\`\`lean code block.

Bias: attempt → compile → read error → fix → compile. Spend your turns COMPILING, not searching or theorising. If after a few honest compile-and-fix rounds the goal is clearly too big for one script, say so and decompose rather than grinding.

${SEARCH_USAGE_NOTE}
${extra ? `\n${extra}\n` : ""}
Theorem:
${theorem}`
}

// The Decomposer subagent's prompt. This run's focus is NOT to finish the proof
// but to BREAK the goal into smaller, equivalent sub-lemmas — the move the agent
// keeps failing to make on its own. It must emit a self-contained scaffold:
//   * helper lemmas H₁…Hₙ, each a real statement with body `:= by sorry`;
//   * the ORIGINAL theorem, its signature untouched, proved FROM those helpers
//     (its own proof has NO sorry — every hole lives in a helper);
//   * helpers written BEFORE the theorem (Lean needs a name declared before use).
// We accept it only if the toolchain confirms the scaffold's sole diagnostics
// are `sorry` warnings — i.e. the reduction genuinely type-checks.
function decomposePrompt(theorem, mcpServers = [], extra = "") {
  const toolSection = mcpToolSection(mcpServers)
  return `You are DECOMPOSING a Lean 4 theorem you could not close directly. Your job on THIS run is not to finish the proof — it is to break the goal into smaller, independently-provable sub-lemmas, so that separate runs can each close one.
${extra ? `\n${extra}\n` : ""}
${toolSection}

MANDATORY FIRST ACTION — get a scaffold on the board before anything else. Your VERY FIRST verify_full_script call (right after loading tools) MUST submit a COMPLETE scaffold: the original theorem reproduced VERBATIM by name, at least one HELPER LEMMA with body \`:= by sorry\`, and your best-attempt proof of the main theorem FROM those helpers. It does NOT need to compile on this first shot — submitting it immediately is what matters. Do NOT explore, search, or step in Pantograph before this scaffold exists. THEN spend every remaining turn fixing ONLY the compile errors (adjust helper statements or the assembly proof), re-running verify_full_script each time, until the sole remaining diagnostics are the helper \`sorry\` warnings. Never end the run without having submitted at least one scaffold that contains the original theorem by name — a run that reaches its turn limit with no master-containing scaffold compiled is a total failure.

Produce a single self-contained Lean scaffold with this exact shape:
  1. One or more HELPER LEMMAS. Each has a real, well-typed signature and a body of exactly \`:= by sorry\`. Give them descriptive, unique names (e.g. \`theorem_name_step_mul_comm\`), never generic ones like \`helper\` or \`aux\`.
  2. The ORIGINAL theorem below, VERBATIM — same name, same signature, do NOT change one character of the statement — proved USING the helper lemmas. Its proof must contain NO \`sorry\`: every remaining hole must live inside a helper, not in the main theorem.
  3. Write the helpers ABOVE the theorem (Lean requires a name to be declared before it is used).

Think like a Lean hacker, not a librarian: pick the mathematical MOVE that cracks this goal (an induction/descent, a parity or mod-n reduction via \`ZMod\` + \`decide\`, a bounded finite check via \`native_decide\`, a bijection via an \`Equiv\` + \`Nat.card_congr\`, a key inequality), and make each helper a step of THAT plan — ideally one closable by strong automation (\`decide\`, \`omega\`, \`nlinarith\`, \`simp\`, \`native_decide\`). Use init_proof/apply_tactic to see the real goal state and discover exactly which intermediate facts the main proof needs. Do NOT spend this run searching the library — reason from your own Lean knowledge and let the compiler confirm the reduction. Each helper must be a genuinely smaller step than the original — a "helper" that just restates the original is not a decomposition.

The decomposition is correct when compiling the scaffold yields NO errors and the only holes are the helper \`sorry\`s — that proves the main theorem really does follow from the helpers. Use verify_full_script to check this: iterate until there are no ERRORS (deprecation/linter warnings are fine; the helper \`sorry\` warnings are expected).

CRITICAL — the target statement is IMMUTABLE. Your scaffold MUST contain the original theorem with its signature reproduced EXACTLY as given below (same name, binders, and statement up to \`:=\`). If you rename it, drop a hypothesis, restate it inductively, or otherwise change the signature, the decomposition is REJECTED even if it compiles. Copy the line below verbatim and only fill in its proof:

  ${normalizeLean(theorem).replace(/\s*:=\s*by\s+sorry\s*$/i, "")} := by
    <your proof using the helper lemmas>

When the scaffold compiles with no errors, output it as a single \`\`\`lean code block.

Original theorem (immutable — reproduce its signature exactly):
${theorem}`
}

// ===========================================================================
// STRATEGY MODES — swappable prompt profiles for A/B testing proof approaches.
// The orchestrator (proveNode/gate/assembly) is strategy-agnostic; a strategy
// only changes the PROMPTS a node-prover and decomposer subagent receive. This
// lets us measure which approach proves more, using the same tree + gates.
// ---------------------------------------------------------------------------

// PANTOGRAPH strategy: make the interactive proof assistant (Leak II) the PRIMARY
// workspace — build the proof one tactic at a time, watching the goal state —
// with verify_full_script (Leak IV) reserved for the FINAL certification/guardrail
// only. Still automation-first, search-last.
function pantographProvePrompt(theorem, mcpServers = [], extra = "") {
  const toolSection = mcpToolSection(mcpServers)
  return `You are proving a Lean 4 + Mathlib theorem the way an expert does: INTERACTIVELY, advancing the goal one tactic at a time in a live proof assistant (Pantograph, via init_proof/apply_tactic) and watching the goal state evolve until no goals remain. You already know Lean 4 — lean on strong automation.

${toolSection}

PRIMARY WORKSPACE — Pantograph (Leak II). Spend your run HERE:
- init_proof { proposition } — open the goal as a live state. The proposition must be CLOSED: quantify every free variable with ∀ (e.g. "∀ (n : ℕ), <goal>"). Use ∈ (never the word "in") for big-operator binders. Returns a state_id.
- apply_tactic { state_id, tactic } — run ONE tactic against that state; see the resulting goals + hypotheses. Chain these (reuse the same state_id) to build the proof.
- get_current_proof_state { state_id } — dump the tactic script so far and the remaining goals.
- NEVER put \`sorry\` in a tactic — Pantograph rejects it. A goal you can't close is a signal to DECOMPOSE, not to sorry.

GUARDRAIL — verify_full_script (Leak IV) is NOT for exploration. Use it ONCE, at the END: when Pantograph shows NO remaining goals, assemble the full \`theorem <original signature> := by <the tactic sequence that worked>\` and verify_full_script it to certify. A proof counts only when that final compile succeeds with no errors and no \`sorry\`.

AUTOMATION FIRST — on each apply_tactic, try a tactic that closes the WHOLE goal before breaking it down by hand: \`decide\`, \`native_decide\`, \`omega\`, \`simp\`/\`simp_all\`, \`norm_num\`, \`nlinarith [sq_nonneg _]\`, \`ring\`, \`aesop\`, \`fin_cases\`/\`interval_cases\`, \`induction\`/\`Nat.strong_induction_on\`. Your FIRST apply_tactic should attempt to finish it outright.

SEARCH (loogle/moogle) is a last resort — only for a specific lemma NAME the assistant says is unknown and you can't recall. Never browse.

WORKFLOW:
0. Load tools (ToolSearch select), first.
1. init_proof with the CLOSED, ∈-normalized proposition, then immediately try to close it in ONE apply_tactic with strong automation.
2. If not closed: intro/step with apply_tactic, making the mathematical move and closing subgoals with automation, watching the state after each step.
3. When no goals remain: get_current_proof_state, assemble the full theorem with the ORIGINAL signature below, verify_full_script ONCE.
4. Output the final verified proof as a single \`\`\`lean block.

If interactive stepping shows the goal needs a substantial lemma best proven separately, say so and decompose.
${extra ? `\n${extra}\n` : ""}
Theorem (prove this EXACT statement; its signature is immutable):
${theorem}`
}

// PANTOGRAPH decomposer: use the interactive assistant to DISCOVER which sub-
// lemmas the proof actually needs (step until you hit goals you can't close;
// those become the helpers), then emit the standard scaffold.
function pantographDecomposePrompt(theorem, mcpServers = [], extra = "") {
  const toolSection = mcpToolSection(mcpServers)
  return `You are DECOMPOSING a Lean 4 theorem you could not close directly, using the interactive proof assistant (Pantograph) to find the RIGHT sub-lemmas.
${extra ? `\n${extra}\n` : ""}
${toolSection}

METHOD — BRIEF Pantograph recon, then scaffold FAST:
- init_proof { proposition } (CLOSED, ∀-quantified, ∈ not "in"), then apply_tactic step by step. Push the proof as far as strong automation takes you; the goals you CANNOT close are exactly the helper lemmas you need. Read them off the live state — don't guess.
- NEVER use \`sorry\` inside a Pantograph tactic (it errors). Just stop stepping when you reach the hard goal and record its statement.
- HARD LIMIT on recon: spend at most the FIRST HALF of your turns stepping in Pantograph. This exploration is only to discover helper statements — the moment you have candidate helpers (or you are halfway through your turns), STOP stepping and submit the scaffold.

MANDATORY — a master-containing scaffold MUST reach verify_full_script well before your turns run out. As soon as recon gives you candidate helpers, submit a COMPLETE scaffold (original theorem verbatim by name + helper lemmas bodied \`:= by sorry\` + best-attempt assembly) via verify_full_script — it need not compile first try — then use remaining turns to fix ONLY its compile errors until the sole diagnostics are the helper \`sorry\`s. A run that ends with no master-containing scaffold compiled is a total failure, no matter how much Pantograph progress you made.

Then emit a single self-contained Lean scaffold:
  1. HELPER LEMMAS — each a real, well-typed statement (the goals you couldn't close), body exactly \`:= by sorry\`, descriptive unique names. Prefer helpers closable by automation.
  2. The ORIGINAL theorem below, VERBATIM (same name and signature), proved FROM the helpers with NO \`sorry\` in its own body.
  3. Helpers ABOVE the theorem (declare before use).

Confirm the scaffold with verify_full_script (Leak IV): iterate until there are NO errors and the only holes are the helper \`sorry\`s. Do not spend this run searching the library.

CRITICAL — the target statement is IMMUTABLE: reproduce its signature EXACTLY (up to \`:=\`). Copy the line below verbatim and only fill in its proof:

  ${normalizeLean(theorem).replace(/\s*:=\s*by\s+sorry\s*$/i, "")} := by
    <your proof using the helper lemmas>

When it compiles with no errors, output the scaffold as a single \`\`\`lean block.

Original theorem (immutable — reproduce its signature exactly):
${theorem}`
}

// LIBRARIAN — the deliberate CONTROL for "does search actually help?". Search-
// first: find the exact Mathlib lemmas, then assemble. Given a LARGE search
// allowance so it's a fair opposite of hacker.
function librarianProvePrompt(theorem, mcpServers = [], extra = "") {
  const toolSection = mcpToolSection(mcpServers)
  return `You are proving a Lean 4 + Mathlib theorem by FINDING AND REUSING THE RIGHT LEMMAS. Mathlib is enormous; the fastest formal proofs cite existing results rather than reproving from scratch. Search first, assemble second.

${toolSection}

APPROACH — library-first:
- moogle_search { concept } — English/semantic search to DISCOVER lemma names ("totient of a prime power", "sum over range is triangular").
- loogle_search { query } — type/pattern search to pin an exact signature once you know roughly what you want. Loogle syntax: names in quotes ("Nat.totient"), patterns with _ placeholders (e.g. \`Nat.totient (_ ^ _)\`); a bare identifier like \`n\` is NOT valid.
- You have a GENEROUS search budget in this mode — use it. Identify each fact the proof needs and find the Mathlib lemma for it.
- verify_full_script (Leak IV) — compile the assembled proof; read errors; fix. init_proof/apply_tactic to inspect a goal state.

WORKFLOW: list the key facts the proof depends on → search Mathlib for each lemma name/signature → write the proof citing them → verify_full_script → fix. Prefer a one-line cite of a library lemma over a hand-rolled argument.

Done ONLY when verify_full_script succeeds on the ORIGINAL theorem below (same name/signature), no \`sorry\`. Output the final proof as one \`\`\`lean block.
${extra ? `\n${extra}\n` : ""}
Theorem:
${theorem}`
}

// SKETCH — plan-then-formalize. Tests whether writing the mathematical argument
// out first (before any tool) improves success on multi-step theorems.
function sketchProvePrompt(theorem, mcpServers = [], extra = "") {
  const toolSection = mcpToolSection(mcpServers)
  return `You are proving a Lean 4 + Mathlib theorem. FIRST think, THEN formalize.

${toolSection}

STEP 1 — SKETCH (before any tool call): write a concise natural-language proof sketch — the key mathematical steps and the lemma/identity each one needs. Name the central move (induction/descent, a reduction, a bijection, a known identity). Keep it tight: 3–8 bullet steps.

STEP 2 — FORMALIZE the sketch step by step. Turn each sketch step into a Lean \`have\` and close it with strong automation (\`decide\`/\`native_decide\`/\`omega\`/\`simp\`/\`nlinarith\`/\`norm_num\`) or a cited lemma. Assemble the steps into the final proof and check with verify_full_script; fix from the compiler's errors. Use init_proof/apply_tactic to see a goal state when a step is fiddly. Search (loogle/moogle) only for a specific unknown lemma NAME.

Done ONLY when verify_full_script succeeds on the ORIGINAL theorem below (same name/signature), no \`sorry\`. Output the final proof as one \`\`\`lean block.
${extra ? `\n${extra}\n` : ""}
Theorem:
${theorem}`
}

// BRUTE — maximal automation only. Cheap baseline: how far does throwing every
// closing tactic (aesop/decide/omega/simp_all/nlinarith/…) get on the ACG set?
function bruteProvePrompt(theorem, mcpServers = [], extra = "") {
  const toolSection = mcpToolSection(mcpServers)
  return `You are proving a Lean 4 + Mathlib theorem by AUTOMATION ALONE, if at all possible. Do NOT search; do minimal hand-work.

${toolSection}

In your FIRST verify_full_script, try heavy closers on the WHOLE goal — one per attempt, cheapest first: \`by decide\`, \`by native_decide\`, \`by omega\`, \`by simp\`, \`by norm_num\`, \`by simp_all\`, \`by aesop\`, \`by nlinarith [sq_nonneg _]\`, \`by positivity\`, and short combos (\`by intro _ <;> simp_all\`, \`by simp_all <;> omega\`, \`by constructor <;> aesop\`). Iterate through these based on the compiler's errors. If a goal splits, throw automation at each piece.

Only if automation genuinely cannot finish, add the MINIMAL manual structure (an intro, an induction, a single rewrite) and hand the resulting subgoals back to automation. If it clearly needs a substantial lemma, say so and decompose.

Done ONLY when verify_full_script succeeds on the ORIGINAL theorem below (same name/signature), no \`sorry\`. Output the final proof as one \`\`\`lean block.
${extra ? `\n${extra}\n` : ""}
Theorem:
${theorem}`
}

// HAVE-based strategy: decompose IN CONTEXT. Instead of extracting top-level
// helper lemmas (which force re-generalizing every local binder + hypothesis — a
// notorious source of errors), the agent writes ONE proof of the master and
// breaks hard steps into local `have <name> : <prop> := by sorry`, which inherit
// the local context natively, then fills them bottom-up. Single agent, one
// context — the deliberate A/B control against the top-level-lemma tree.
// Research-mode directive shared by every prover agent (planner / minion /
// finisher). Kills the "this looks like an open/hard conjecture, I'll stop and
// report" failure mode: the agent may not judge provability, only work the goal.
const RESEARCH_MODE_NOTE = `RESEARCH MODE — you attack goals that may be UNSOLVED. Rules of engagement:
- NEVER assess whether the goal is "open", "famous", "hard", a "known conjecture", or "beyond current tools". You cannot know that and it is irrelevant — just work the goal in front of you.
- Do NOT stop to REPORT difficulty, summarize the literature, or explain why something can't be done. Those are not outputs.
- Your ONLY valid outputs are: (a) a verified proof, or (b) a further DECOMPOSITION of the goal into smaller sub-goals.
- "I couldn't prove it" / "this is an open problem" is NOT a stopping state. If a step resists, BREAK IT SMALLER and hand the pieces on. Progress = shrinking the unproved part, not closing it in one shot.
- Never return empty-handed: always emit your best partial \`have\` steps or tactics so the next agent builds on them, never nothing.`

// How deep the have-tree may recursively re-decompose a resisting hole before the
// residual is handed to the single-context finisher. Bounds proof nesting (not
// wall-clock — time is governed separately).
const MAX_DECOMP_DEPTH = 4

function haveProvePrompt(theorem, mcpServers = [], extra = "") {
  const toolSection = mcpToolSection(mcpServers)
  return `You are proving a Lean 4 + Mathlib theorem by IN-CONTEXT DECOMPOSITION. You write ONE self-contained proof of the theorem and break every hard step into a LOCAL \`have\`, NEVER a top-level helper lemma.

${toolSection}

${RESEARCH_MODE_NOTE}

METHOD — scaffold with \`have\`, then fill:
1. Reproduce the ORIGINAL theorem below VERBATIM (same name and signature) and open its proof with \`by\`.
2. Lay out the argument as local steps: \`have h₁ : <prop> := by sorry\`, \`have h₂ : <prop> := by sorry\`, … then close the main goal FROM those \`have\`s. Each \`have\` inherits all local hypotheses and bound variables automatically — do NOT re-quantify or re-pass them. That inheritance is the whole point: it eliminates the binder-generalization errors that top-level lemmas cause.
3. verify_full_script this SKELETON first: it must compile with the ONLY holes being your \`have … := by sorry\` (deprecation/linter warnings are fine). That proves your decomposition is structurally valid before you invest in the hard parts.
4. Then FILL each \`have\` one at a time, replacing its \`sorry\` with a real proof — lead with strong automation (\`decide\`, \`native_decide\`, \`omega\`, \`simp_all\`, \`nlinarith\`, \`induction\`); if a \`have\` is itself hard, nest more \`have\`s inside it. verify_full_script after each fill so the compiler guides you.

RULES:
- NEVER introduce a top-level \`theorem\`/\`lemma\` other than the master itself — ALL structure lives in \`have\`s inside the one proof.
- Think like a Lean hacker: reason from your own knowledge + the compiler's errors; search is a last resort.
- Done ONLY when verify_full_script succeeds on the master with NO \`sorry\` and NO errors. Output the final proof as one \`\`\`lean block.

${SEARCH_USAGE_NOTE}
${extra ? `\n${extra}\n` : ""}
Theorem (prove this EXACT statement; its signature is immutable):
${theorem}`
}

// The registry. Each strategy supplies a node-prover prompt, a decomposer prompt,
// and an optional search budget (how much library search that mode is rationed
// to — the governor enforces it). `search` defaults to GOV_INITIAL.
const STRATEGIES = {
  hacker: {
    label: "Hacker — compiler-driven, verify_full_script as the main loop",
    node: (t, m, x) => provePrompt(t, m, x),
    decompose: (t, m, x) => decomposePrompt(t, m, x),
    search: GOV_INITIAL,
  },
  pantograph: {
    label: "Pantograph — interactive Leak II as the workspace, Leak IV only as guardrail",
    node: (t, m, x) => pantographProvePrompt(t, m, x),
    decompose: (t, m, x) => pantographDecomposePrompt(t, m, x),
    search: GOV_INITIAL,
  },
  librarian: {
    label: "Librarian — search-first control; find & cite Mathlib lemmas",
    node: (t, m, x) => librarianProvePrompt(t, m, x),
    decompose: (t, m, x) => decomposePrompt(t, m, x),
    search: 30, // generous, so it's a fair opposite of hack-first
  },
  sketch: {
    label: "Sketch — plan the argument in words, then formalize step by step",
    node: (t, m, x) => sketchProvePrompt(t, m, x),
    decompose: (t, m, x) => decomposePrompt(t, m, x),
    search: GOV_INITIAL,
  },
  brute: {
    label: "Brute — automation only (aesop/decide/omega/simp_all/nlinarith)",
    node: (t, m, x) => bruteProvePrompt(t, m, x),
    decompose: (t, m, x) => decomposePrompt(t, m, x),
    search: 0, // brute mode does not search
  },
  // A/B control for the whole tree approach: decompose via LOCAL `have`s inside
  // ONE proof (single agent, no top-level lemmas, no cross-agent hand-off), vs
  // the `lemma`-style strategies above that farm top-level helpers to a tree.
  have: {
    label: "Have — in-context `have` decomposition (single agent, no top-level lemmas)",
    node: (t, m, x) => haveProvePrompt(t, m, x),
    decompose: (t, m, x) => haveProvePrompt(t, m, x), // unused in `have` style; keeps the registry shape
    search: GOV_INITIAL,
    style: "have",
  },
  // Phase-1 linear context: planner writes a `have`-skeleton, isolated minions
  // fill each hole, an assembler stitches + re-verifies. Bounded context per
  // agent; falls back to `have` on any failure. See proveHaveTree.
  "have-tree": {
    // Named "Leak Stronghold Dark" in the research tables; the VALUE stays
    // `have-tree` so saved checkpoints, queued items and existing rows keep
    // resolving. See STRONGHOLD_LABELS on the client for the display name.
    label: "Leak Stronghold Dark — planner + isolated per-hole minions (linear context)",
    node: (t, m, x) => haveTreePlannerPrompt(t, m, x),
    decompose: (t, m, x) => haveHoleFillPrompt("<the verified skeleton>", "hN", m, x),
    search: GOV_INITIAL,
    style: "have-tree",
  },
  // ---- Leak River family -----------------------------------------------------
  // Goedel-Architect (arXiv 2606.06468): blueprint generation -> parallel
  // isolated node provers -> global blueprint refinement, on the real
  // LeanArchitect toolchain via Leak XI/XII/XIV. Driven by Grok (xAI API),
  // not the Claude CLI — see proveArchitect.
  //
  // Three variants, each an ablation of the one before it, so the research
  // tables isolate exactly one change at a time:
  //   river-stone  CONTROL — the paper as written, nothing added.
  //   river-gate   + shared dead-end ledger across node provers.
  //   river-delta  + a one-shot local Sonnet 5 natural-language proof seed.
  "river-stone": {
    label: "Leak River Stone — CONTROL: bare Goedel blueprint pipeline, isolated nodes",
    node: (t, m, x) => architectProverSystem(),
    decompose: (t, m, x) => architectRefineSystem(),
    search: 0,
    style: "architect",
    architect: { shareDeadEnds: false, nlSeedLocal: false },
  },
  "river-gate": {
    label: "Leak River Gate — Stone + shared dead-end ledger (no node rediscovers another's wall)",
    node: (t, m, x) => architectProverSystem(),
    decompose: (t, m, x) => architectRefineSystem(),
    search: 0,
    style: "architect",
    architect: { shareDeadEnds: true, nlSeedLocal: false },
  },
  "river-delta": {
    label: "Leak River Delta — Gate + one-shot local Sonnet 5 natural-language proof seed",
    node: (t, m, x) => architectProverSystem(),
    decompose: (t, m, x) => architectRefineSystem(),
    search: 0,
    style: "architect",
    architect: { shareDeadEnds: true, nlSeedLocal: true },
  },
  // ---- Leak Ultra family -------------------------------------------------------
  // The same Goedel blueprint pipeline as Leak River Stone — identical prompts,
  // identical tool contract, identical Leak XI/XII/XIV gates — but driven by the
  // LOCAL Claude CLI instead of the xAI API, on whatever model the operator picks
  // in the dropdown. A separate branch, not a River ablation: the driver changes,
  // so its numbers belong in their own table.
  //
  // The driver swap is real work, not a model string: the CLI calls MCP tools
  // itself, so the bridge serves `lean_compile`/`mathlib_search` to it from a
  // LOCAL MCP server (the governor) whose handlers are the very same `exec`
  // closures the Grok loop uses. That keeps the compile gate and the blueprint
  // capture on the bridge, where they have to be — the CLI is never trusted to
  // self-report that a blueprint compiled.
  "ultra-fleeting": {
    label: "Leak Ultra Fleeting — Stone's pipeline, local Claude CLI driver (model from the dropdown)",
    node: (t, m, x) => architectProverSystem(),
    decompose: (t, m, x) => architectRefineSystem(),
    search: 0,
    style: "architect",
    architect: { shareDeadEnds: false, nlSeedLocal: false, driver: "claude" },
  },
  // Back-compat: runs saved/queued under the old name behave as the control.
  architect: {
    label: "Architect — alias for Leak River Stone (control)",
    node: (t, m, x) => architectProverSystem(),
    decompose: (t, m, x) => architectRefineSystem(),
    search: 0,
    style: "architect",
    architect: { shareDeadEnds: false, nlSeedLocal: false },
  },
}
// Per-variant architect knobs (see the Leak River family above). Unknown or
// non-architect strategies get the control's settings.
const architectConfigFor = (name) =>
  pickStrategy(name).architect || { shareDeadEnds: false, nlSeedLocal: false }
// Which LLM drives the architect pipeline: "grok" (xAI API, the River family) or
// "claude" (the local CLI, Leak Ultra). Anything unset is Grok, so the River
// variants and the legacy alias are untouched.
const architectDriverFor = (name) => (architectConfigFor(name).driver === "claude" ? "claude" : "grok")

// ── Lean toolchain provenance ────────────────────────────────────────────────
// The two verifier groups DO NOT run the same Lean. A certificate that names the
// wrong one is a false claim about how the proof was checked, so the toolchain is
// carried per run (from whichever group actually certified the proof) instead of
// being assumed. Sources: Leak II/IV lean-toolchain + lake-manifest (mathlib tag
// v4.29.1, rev 5e932f9…); Leak XII/XIV gateway/lean-toolchain + lakefile.toml
// (mathlib tag v4.32.0). Update these together with those pins.
const TOOLCHAINS = {
  // Leak I / II / IV — the original group, gate = verify_full_script.
  legacy: { lean: "leanprover/lean4:v4.29.1", mathlib: "v4.29.1", group: "Leak I/II/IV" },
  // Leak XI / XII / XIV — the LeanArchitect group, gate = Leak XIV.
  architect: { lean: "leanprover/lean4:v4.32.0", mathlib: "v4.32.0", group: "Leak XI/XII/XIV" },
}
// Which pins applied to THIS run, keyed off the orchestrator style: the architect
// styles are certified by Leak XIV, everything else by the Leak II/IV daemon.
const toolchainForStyle = (style) => (style === "architect" ? TOOLCHAINS.architect : TOOLCHAINS.legacy)
// Decomposition STYLE selects the orchestrator: "lemma" = the top-level-lemma
// prove-or-split tree (proveNode); "have" = a single agent decomposing in-context
// with local `have`s (proveHaveFlat). Defaults to "lemma" for existing modes.
const styleOf = (name) => pickStrategy(name).style || "lemma"
const pickStrategy = (name) => STRATEGIES[name] || STRATEGIES.hacker
const nodePromptFor = (name, t, m, x) => pickStrategy(name).node(t, m, x)
const decomposePromptFor = (name, t, m, x) => pickStrategy(name).decompose(t, m, x)
const searchBudgetFor = (name) => {
  const b = pickStrategy(name).search
  return Number.isFinite(b) ? b : GOV_INITIAL
}

// Non-streaming prove used by the /prove route AND the customer-traffic worker.
// GUARDRAIL: this must NOT trust the model's final prose. Like /prove-stream it
// runs stream-json and feeds every line through the SHARED makeProofGate, so a
// result is only "verified" when the daemon confirmed a target-matching, sorry-
// free script. `verified`/`proof` reflect that gate; `finalText` is the model's
// closing message, kept only for diagnostics. The worker charges on `verified`.
// Rough per-model USD pricing for the MID-RUN spend guard ONLY. The customer's
// actual bill uses the CLI's authoritative total_cost_usd; this just lets the
// worker abort a run before it blows past the balance, since the CLI reports
// cost only on its final frame. $/1M in/out from the model table; cache read =
// 0.1× input, 5-min write = 1.25×, 1-hour write = 2×.
const MODEL_PRICE = [
  [/grok-4\.3|grok-4-3/i, { i: 1.25, o: 2.5 }],
  [/grok/i, { i: 0.2, o: 0.5 }],
  [/opus/i, { i: 5, o: 25 }],
  [/sonnet/i, { i: 3, o: 15 }],
  [/haiku/i, { i: 1, o: 5 }],
  [/fable|mythos/i, { i: 10, o: 50 }],
]
function modelPrice(model) {
  for (const [re, p] of MODEL_PRICE) if (re.test(String(model || ""))) return p
  return { i: 5, o: 25 } // default to opus-tier
}
function priceUsageUsd(usage, model) {
  if (!usage) return 0
  const p = modelPrice(model)
  const inTok = Number(usage.input_tokens) || 0
  const outTok = Number(usage.output_tokens) || 0
  const readTok = Number(usage.cache_read_input_tokens) || 0
  const cc = usage.cache_creation || {}
  const w5 = Number(cc.ephemeral_5m_input_tokens) || 0
  const w1h = Number(cc.ephemeral_1h_input_tokens) || 0
  const wFlat = w5 || w1h ? 0 : Number(usage.cache_creation_input_tokens) || 0
  return (
    (inTok * p.i +
      outTok * p.o +
      readTok * 0.1 * p.i +
      (w5 + wFlat) * 1.25 * p.i +
      w1h * 2 * p.i) /
    1e6
  )
}

function runProve(theorem, mcpServers, opts = {}) {
  theorem = normalizeProblemSyntax(theorem)
  return new Promise((resolve) => {
    const start = Date.now()

    let cfgPath
    try {
      const dir = mkdtempSync(join(tmpdir(), "claude-prove-"))
      cfgPath = join(dir, "mcp.json")
      writeFileSync(cfgPath, JSON.stringify(buildMcpConfig(mcpServers)))
    } catch (e) {
      resolve({ ok: false, verified: false, proof: "", finalText: "", stderr: `failed to write mcp config: ${e.message}`, durationMs: 0 })
      return
    }

    // Flags verified against Claude Code 2.1.x: strict-mcp-config uses only these
    // servers, dangerously-skip-permissions lets the agent call the MCP tools
    // without prompting (it's the user's own machine + own tools). stream-json
    // (not json) so we can watch each verify_full_script result as it lands.
    const args = [
      "-p", provePrompt(theorem, mcpServers),
      "--output-format", "stream-json", "--verbose",
      "--mcp-config", cfgPath,
      "--strict-mcp-config",
      "--dangerously-skip-permissions",
    ]
    if (opts.model) args.push("--model", opts.model)

    let child
    try {
      child = spawn(CLAUDE_BIN, args, {
        cwd: opts.workingDirectory || process.cwd(),
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
      })
    } catch (e) {
      resolve({ ok: false, verified: false, proof: "", finalText: "", stderr: `Failed to launch "${CLAUDE_BIN}": ${e.message}`, durationMs: Date.now() - start })
      return
    }

    const gate = makeProofGate(theorem)
    // Worker / non-streaming path: there's no browser Terminate here, so keep a
    // generous default cap to protect the autonomous worker from a hung job —
    // but honor opts.timeoutMs === 0 as "no cap" for callers that want it.
    const timeoutMs =
      Number(opts.timeoutMs) === 0
        ? 0
        : Math.min(Math.max(Number(opts.timeoutMs) || 1800000, 30000), 21600000)
    let timedOut = false
    const timer =
      timeoutMs > 0
        ? setTimeout(() => {
            timedOut = true
            child.kill("SIGKILL")
          }, timeoutMs)
        : null

    let buf = ""
    let stderr = ""
    let finalText = ""
    let costUsd = 0 // authoritative, summed from CLI `result` frames
    let runningCostUsd = 0 // per-turn estimate for the mid-run spend guard
    let budgetExceeded = false
    let stopping = false
    // Hard USD ceiling for this run (balance / (markup × fx)); ∞ ⇒ no cap.
    const maxCostUsd = Number(opts.maxCostUsd)
    const hasBudget = Number.isFinite(maxCostUsd) && maxCostUsd > 0
    const stopChild = (signal) => {
      if (stopping) return
      stopping = true
      try {
        child.kill(signal)
        // hard-kill fallback if it doesn't exit after flushing its result frame
        setTimeout(() => {
          try {
            child.kill("SIGKILL")
          } catch {}
        }, PROOF_STOP_GRACE_MS).unref?.()
      } catch {
        /* already gone */
      }
    }

    child.stdout.on("data", (chunk) => {
      buf += chunk.toString("utf8")
      let nl
      while ((nl = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, nl)
        buf = buf.slice(nl + 1)
        if (!line.trim()) continue
        let o
        try {
          o = JSON.parse(line)
        } catch {
          continue
        }
        // Cost: sum authoritative totals off result frames; estimate per-turn
        // from assistant usage so the guard can act before the final frame.
        if (o.type === "result" && typeof o.total_cost_usd === "number") {
          costUsd += o.total_cost_usd
        }
        if (o.type === "assistant" && o.message?.usage) {
          runningCostUsd += priceUsageUsd(o.message.usage, o.message.model)
        }
        // Mid-run spend guard: abort the instant the metered charge would exhaust
        // the balance. SIGINT (not SIGKILL) so the CLI flushes its cost frame.
        if (hasBudget && !budgetExceeded && Math.max(costUsd, runningCostUsd) >= maxCostUsd) {
          budgetExceeded = true
          stopChild("SIGINT")
        }
        const ev = gate.observe(o)
        if (ev?.verified) {
          // Target proved + daemon-confirmed — stop now (SIGINT so the final
          // cost frame flushes) instead of wandering to the timeout.
          stopChild("SIGINT")
        }
        if (o.type === "result") finalText = o.result || ""
      }
    })

    child.stderr.on("data", (c) => {
      stderr += c.toString("utf8")
    })

    child.on("error", (e) => {
      clearTimeout(timer)
      resolve({ ok: false, verified: false, proof: "", finalText, exitCode: null, durationMs: Date.now() - start, timedOut, stderr: e.message })
    })
    child.on("close", (code) => {
      clearTimeout(timer)
      const verifiedScript = gate.verifiedScript
      resolve({
        // ok = the process ran cleanly; verified = the daemon-gated proof exists.
        ok: (code === 0 || !!verifiedScript) && !timedOut,
        verified: !!verifiedScript,
        proof: verifiedScript || "",
        finalText,
        exitCode: code,
        durationMs: Date.now() - start,
        timedOut,
        budgetExceeded,
        costUsd, // authoritative total_cost_usd for billing
        stderr: budgetExceeded
          ? "aborted: run cost would exceed remaining balance"
          : stderr,
      })
    })
  })
}

// Streaming variant of /prove: runs Claude with stream-json and translates each
// event into the app's SSE shape (message-annotation for tool activity,
// text-delta for the final proof) so the main chat's activity panel renders it.
// Single-agent SSE entrypoint. Goes straight to the prover.
//
// NOTE: the disproof/counterexample pre-check was removed — it ran a Lean daemon
// disproof sweep before EVERY prove (pure overhead on the ~all-true problems) and
// false-positive detection is being replaced by a separate system. See buildRefute*
// helpers below, kept dead for that future system.
async function proveStream(res, theorem, mcpServers, opts = {}) {
  theorem = normalizeProblemSyntax(theorem)
  proveStreamRun(res, theorem, mcpServers, opts)
}

function proveStreamRun(res, theorem, mcpServers, opts = {}) {
  theorem = normalizeProblemSyntax(theorem)
  let cfgPath
  try {
    const dir = mkdtempSync(join(tmpdir(), "claude-prove-"))
    cfgPath = join(dir, "mcp.json")
    writeFileSync(cfgPath, JSON.stringify(buildMcpConfig(mcpServers)))
  } catch (e) {
    res.writeHead(500, { "content-type": "text/event-stream" })
    res.write(`data: ${JSON.stringify({ type: "error", message: `mcp config: ${e.message}` })}\n\n`)
    res.end()
    return
  }

  const systemPrompt = provePrompt(theorem, mcpServers)
  const args = [
    "-p", systemPrompt,
    "--output-format", "stream-json", "--verbose",
    "--mcp-config", cfgPath, "--strict-mcp-config", "--dangerously-skip-permissions",
  ]
  if (opts.model) args.push("--model", opts.model)

  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache, no-transform" })
  const send = (obj) => {
    try {
      res.write(`data: ${JSON.stringify(obj)}\n\n`)
    } catch {
      /* client gone */
    }
  }

  // Surface the EXACT context handed to the agent so the app can log it for
  // debugging (admin only): the full system prompt, the model, and the resolved
  // MCP servers + tool inventory. Emitted before anything runs.
  send({
    type: "prompt",
    prompt: systemPrompt,
    model: opts.model || null,
    theorem,
    mcpServers: (mcpServers || []).map((s) => ({
      name: s?.name,
      url: s?.url,
      tools: Array.isArray(s?.tools)
        ? s.tools.map((t) => (typeof t === "string" ? t : t?.name)).filter(Boolean)
        : undefined,
    })),
  })

  const start = Date.now()
  // Single-agent path: always gated by verify_full_script on the Leak II/IV
  // daemon, so the legacy pins are the honest ones to report.
  const metrics = {
    tools_invoked: 0,
    llm_invocations: 0,
    time_elapsed: 0,
    bridge_build: BRIDGE_BUILD,
    lean_toolchain: TOOLCHAINS.legacy.lean,
    mathlib_version: TOOLCHAINS.legacy.mathlib,
    verifier_group: TOOLCHAINS.legacy.group,
  }
  const stripName = (n) => String(n || "").replace(/^mcp__[a-z0-9-]+__/i, "")

  // System gate: the ONE enforced restriction. We only accept a proof that the
  // harness itself watched pass verify_full_script — not one Claude merely
  // claims. This is the SAME makeProofGate the worker's runProve uses, so the
  // ACG/interactive path and customer traffic can never diverge on what counts.
  const gate = makeProofGate(theorem)

  let child
  try {
    child = spawn(CLAUDE_BIN, args, {
      cwd: opts.workingDirectory || process.cwd(),
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    })
  } catch (e) {
    send({ type: "error", message: `Failed to launch "${CLAUDE_BIN}": ${e.message}` })
    res.end()
    return
  }

  // No hard timeout by default — a hard theorem can legitimately take a long time
  // and shouldn't be killed mid-proof. Termination is the operator's job: the
  // browser's Terminate button disconnects, and res "close" (below) kills the
  // child. Pass a positive opts.timeoutMs to opt back into a cap.
  const timeoutMs = Number(opts.timeoutMs) > 0 ? Math.min(Number(opts.timeoutMs), 21600000) : 0
  const timer =
    timeoutMs > 0
      ? setTimeout(() => {
          send({ type: "error", message: "Prover timed out." })
          child.kill("SIGKILL")
        }, timeoutMs)
      : null

  let buf = ""
  let stderr = ""
  let finalText = ""
  // Set once the proof gate confirms — so the interrupt-to-flush-cost logic
  // fires exactly once (later frames, incl. the flushed `result`, must not
  // re-signal).
  let proofFoundStop = false

  child.stdout.on("data", (chunk) => {
    buf += chunk.toString("utf8")
    let nl
    while ((nl = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, nl)
      buf = buf.slice(nl + 1)
      if (!line.trim()) continue
      let o
      try {
        o = JSON.parse(line)
      } catch {
        continue
      }
      metrics.time_elapsed = Math.round((Date.now() - start) / 1000)

      // Feed EVERY object to the shared proof gate first — it tracks
      // verify_full_script calls and records a daemon-verified, gate-passing
      // script. Then emit the display events below.
      const ev = gate.observe(o)
      if (ev?.verified && !proofFoundStop) {
        proofFoundStop = true
        // Target theorem proved. Claude won't self-terminate on a tool success,
        // so stop it now instead of letting it wander until the timeout; the
        // close handler emits the verified proof.
        //
        // SIGINT (not SIGKILL): the CLI flushes its final `result` frame on an
        // interrupt, and that frame is the ONLY carrier of total_cost_usd. A hard
        // SIGKILL here races the result frame and drops the cost — which is why
        // daemon-verified proofs showed no actual cost. Hard-kill only as a grace
        // fallback if the CLI doesn't exit promptly after flushing.
        try {
          child.kill("SIGINT")
          setTimeout(() => {
            try {
              child.kill("SIGKILL")
            } catch {
              /* already gone */
            }
          }, PROOF_STOP_GRACE_MS).unref?.()
        } catch {
          /* already gone */
        }
      } else if (ev?.rejected) {
        // Verified, but it's not the target theorem (a helper/example) — keep going.
        send({
          type: "message-annotation",
          subtype: "status",
          thought:
            "✔️ A script verified, but it does not contain the target theorem — still unproven.",
          metrics,
        })
      }

      if (o.type === "assistant" && o.message?.content) {
        metrics.llm_invocations++
        for (const c of o.message.content) {
          if (c.type === "tool_use") {
            metrics.tools_invoked++
            const name = stripName(c.name)
            send({
              type: "message-annotation",
              subtype: "tool_intent",
              thought: `Using ${name}`,
              tool: name,
              input: typeof c.input === "string" ? c.input : JSON.stringify(c.input),
              metrics,
            })
          } else if (c.type === "text" && c.text && c.text.trim()) {
            send({ type: "message-annotation", subtype: "status", thought: c.text.trim().slice(0, 300), metrics })
          } else if (c.type === "thinking" && c.thinking) {
            // Extended-thinking blocks — stream the model's reasoning.
            send({ type: "thinking", text: String(c.thinking).slice(0, 2000), metrics })
          }
        }
      } else if (o.type === "user" && o.message?.content) {
        for (const c of o.message.content) {
          if (c.type === "tool_result") {
            const t = Array.isArray(c.content)
              ? c.content.map((x) => x.text || "").join("\n")
              : String(c.content ?? "")
            send({ type: "message-annotation", subtype: "tool_result", thought: "Tool output", output: t, metrics })
          }
        }
      } else if (o.type === "result") {
        finalText = o.result || ""
        // Actual cost: the CLI's final result frame carries total_cost_usd (a
        // dollar-equivalent even on the Max plan; real spend on API credits) and
        // usage. Accumulate onto the shared metrics so `done` reports it.
        if (typeof o.total_cost_usd === "number") metrics.cost_usd = (metrics.cost_usd || 0) + o.total_cost_usd
        if (o.usage) metrics.tokens = (metrics.tokens || 0) + usageTokens(o.usage)
      } else if (o.type === "system" && (o.subtype === "init" || o.model)) {
        // ONLY the init frame — it carries the run context (model, the MCP
        // servers it connected, how many tools it can drive). Claude Code also
        // emits other bare `system` frames (status / MCP (re)connect); relaying
        // those spams the UI with meaningless "Prover initialised" rows.
        const servers = Array.isArray(o.mcp_servers)
          ? o.mcp_servers.map((s) => s?.name || s).filter(Boolean).join(", ")
          : ""
        const nTools = Array.isArray(o.tools) ? o.tools.length : undefined
        send({
          type: "system",
          model: o.model,
          detail: [servers && `MCP: ${servers}`, nTools != null && `${nTools} tools`]
            .filter(Boolean)
            .join(" · "),
          metrics,
        })
      }
    }
  })

  child.stderr.on("data", (c) => {
    stderr += c.toString("utf8")
  })

  child.on("error", (e) => {
    clearTimeout(timer)
    send({ type: "error", message: e.message })
    res.end()
  })
  child.on("close", () => {
    clearTimeout(timer)
    // Enforce the gate: accept only a harness-verified script.
    const verifiedScript = gate.verifiedScript
    if (verifiedScript) {
      send({
        type: "message-annotation",
        subtype: "status",
        thought: "✅ System check passed — script verified with no errors.",
        metrics,
      })
      send({ type: "text-delta", content: `✅ **Verified proof** (confirmed by verify_full_script):\n\n\`\`\`lean\n${verifiedScript}\n\`\`\`` })
    } else {
      send({
        type: "message-annotation",
        subtype: "error",
        thought: "❌ System check failed — no script passed verify_full_script.",
        metrics,
      })
      const detail = finalText
        ? `⚠️ Not accepted — no verify_full_script call succeeded, so this is unverified:\n\n${finalText}`
        : stderr.trim()
          ? `Error: ${stderr.trim().slice(0, 500)}`
          : "No verified proof was produced."
      send({ type: "text-delta", content: detail })
    }
    // Include a clean machine-readable outcome for the automated pipeline.
    send({ type: "done", metrics, verified: !!verifiedScript, proof: verifiedScript || "" })
    res.end()
  })

  res.on("close", () => {
    clearTimeout(timer)
    try {
      child.kill("SIGKILL")
    } catch {
      /* already gone */
    }
  })
}

// ===========================================================================
// PROOF-TREE ORCHESTRATOR (Phase 3)
// ---------------------------------------------------------------------------
// Drives the tree: each node is proved directly with a bounded turn budget; if
// it stalls (or the agent asks), a Decomposer run splits it into sub-lemmas
// (structurally verified), each of which becomes a child node — recursively.
// When all leaves are genuinely closed, the subtree is assembled bottom-up and
// gated on ONE final sorry-free compile. All subagent runs stream into the same
// SSE console via `emit`.
// ---------------------------------------------------------------------------

const clampNum = (v, lo, hi, dflt) => {
  const n = Number(v)
  return Number.isFinite(n) ? Math.min(Math.max(n, lo), hi) : dflt
}
// ── Live compute-budget registry ─────────────────────────────────────────────
// A streaming prove run may carry a WALL-CLOCK budget (options.computeBudgetMs).
// We register it here under a runId with a MUTABLE deadline; the subprocess
// killers read the deadline LIVE (not a fixed timer), so the UI's "+5 min" button
// (POST /extend) rescues even the stage that's currently running. No budget (0)
// means uncapped — deadline Infinity — preserving the old "let it run" behavior.
// `maxIters` is the Leak River refinement budget, mutable for the same reason:
// the UI's "+1 iter" button must be able to rescue a run that is already on its
// final iteration, not just configure the next run.
const ACTIVE_RUNS = new Map() // runId -> { deadlineMs, budgetMs, maxIters }
function registerRun(budgetMs, maxIters = 0) {
  const runId = randomUUID()
  const st = {
    deadlineMs: budgetMs > 0 ? Date.now() + budgetMs : Infinity,
    budgetMs: budgetMs > 0 ? budgetMs : 0,
    maxIters: maxIters > 0 ? maxIters : 0,
  }
  ACTIVE_RUNS.set(runId, st)
  return { runId, st }
}
// True once a governed run's wall-clock budget is spent (used to stop retrying).
function deadlinePassed(ctx) {
  if (typeof ctx?.getDeadline !== "function") return false
  const dl = ctx.getDeadline()
  return Number.isFinite(dl) && Date.now() >= dl
}
// Human label for the SHARED clock every agent (planner, minions, finisher) runs
// against. Governance is purely TIME now — no turn caps — and the "+5 min" button
// pushes this same deadline out for all of them at once.
function remainingLabel(ctx) {
  const dl = typeof ctx?.getDeadline === "function" ? ctx.getDeadline() : Infinity
  if (!Number.isFinite(dl)) return "no time cap — runs until you Terminate"
  const m = Math.max(0, Math.round((dl - Date.now()) / 60000))
  return `~${m} min left on the shared clock`
}

const oneLine = (s) => String(s || "").replace(/\s+/g, " ").trim().slice(0, 120)
const declName = (sig) => {
  const m = String(sig || "").match(/\b(?:theorem|lemma)\s+([^\s({\[:]+)/)
  return m ? m[1] : "lemma"
}

// Map one claude stream-json object to the app's display SSE events (same shapes
// proveStream uses, so the existing client renders them unchanged). `stage`
// prefixes tool/status labels with the current tree position; `metrics` is the
// shared live counter object attached by the caller's emit wrapper.
function mapObjectToEvents(o, emit, stage, metrics) {
  const tag = stage ? `${stage} ` : ""
  const stripName = (n) => String(n || "").replace(/^mcp__[a-z0-9-]+__/i, "")
  if (o.type === "assistant" && o.message?.content) {
    if (metrics) metrics.llm_invocations++
    for (const c of o.message.content) {
      if (c.type === "tool_use") {
        if (metrics) metrics.tools_invoked++
        const name = stripName(c.name)
        emit({
          type: "message-annotation",
          subtype: "tool_intent",
          thought: `${tag}Using ${name}`,
          tool: name,
          input: typeof c.input === "string" ? c.input : JSON.stringify(c.input),
        })
      } else if (c.type === "text" && c.text && c.text.trim()) {
        emit({ type: "message-annotation", subtype: "status", thought: `${tag}${c.text.trim().slice(0, 300)}` })
      } else if (c.type === "thinking" && c.thinking) {
        emit({ type: "thinking", text: String(c.thinking).slice(0, 2000) })
      }
    }
  } else if (o.type === "user" && o.message?.content) {
    for (const c of o.message.content) {
      if (c.type === "tool_result") {
        const t = Array.isArray(c.content)
          ? c.content.map((x) => x.text || "").join("\n")
          : String(c.content ?? "")
        emit({ type: "message-annotation", subtype: "tool_result", thought: "Tool output", output: t })
      }
    }
  }
}

// Spawn ONE focused claude subagent with stream-json, feed each parsed object to
// `onObject` (which returns true to stop the run early — e.g. goal closed), and
// mirror activity into the console via `emit`. Shared by the node-prover and the
// decomposer. Resolves when the process exits.
function spawnProverStream({ prompt, mcpServers, model, maxTurns, timeoutMs, getDeadline, stage, metrics, signal, searchBudget, bridgeHandlers, systemAppend }, { onObject, emit }) {
  return new Promise((resolve) => {
    // Each subagent run gets its OWN search governor (budget resets per node /
    // per decomposition — a fresh sub-goal earns a fresh allowance). The initial
    // budget is strategy-dependent (e.g. librarian gets a large one). Search tools
    // are routed through the bridge; verify + Pantograph stay direct.
    const governor = createGovernor({ initial: searchBudget })
    // Bridge-served tools (the architect stages' own executors) ride the same
    // local MCP server as the governed search, so the CLI reaches them without
    // ever talking to Leak XII/XIV directly.
    if (bridgeHandlers) for (const [n, h] of bridgeHandlers) governor.handlers.set(n, h)
    let cfgPath
    try {
      const dir = mkdtempSync(join(tmpdir(), "claude-tree-"))
      cfgPath = join(dir, "mcp.json")
      writeFileSync(cfgPath, JSON.stringify(buildGovernedMcpConfig(mcpServers, governor)))
    } catch (e) {
      destroyGovernor(governor)
      resolve({ ok: false, finalText: "", exitCode: null, timedOut: false, stderr: `mcp config: ${e.message}` })
      return
    }
    // Track verify calls (id -> the script submitted) so we can refill the
    // search budget when a REAL proof attempt reports an unknown NAME — and
    // withhold the refill from bare name-probing scripts.
    const verifyCalls = new Map()
    const args = [
      "-p", prompt,
      "--output-format", "stream-json", "--verbose",
      "--mcp-config", cfgPath, "--strict-mcp-config", "--dangerously-skip-permissions",
      // The prover PROVES — it does not browse the literature. WebSearch/WebFetch
      // were a surrender hatch: the agent would look up "is this open/hard", find
      // it's an unsolved conjecture, and stop — burning the run on research instead
      // of the compiler. Cut them. (Leak I loogle/moogle stay for LEAN lemma search,
      // and Bash stays — numeric witness-finding is real proof work.)
      "--disallowedTools", ...PROVER_DISALLOWED_TOOLS,
    ]
    if (model) args.push("--model", model)
    if (Number.isFinite(maxTurns) && maxTurns > 0) args.push("--max-turns", String(Math.floor(maxTurns)))
    // The architect stage contract (blueprint rules / prover rules / refinement
    // rules) rides as a system prompt so it outranks the conversation, matching
    // how the Grok driver sends it as role:"system".
    if (typeof systemAppend === "string" && systemAppend.trim())
      args.push("--append-system-prompt", systemAppend.trim())

    let child
    try {
      child = spawn(CLAUDE_BIN, args, { cwd: process.cwd(), shell: false, stdio: ["ignore", "pipe", "pipe"] })
    } catch (e) {
      resolve({ ok: false, finalText: "", exitCode: null, timedOut: false, stderr: `Failed to launch "${CLAUDE_BIN}": ${e.message}` })
      return
    }
    // No hard per-node cap by default (0 = uncapped). A tree node can be a long
    // proof; the whole run is bounded by maxNodes and the operator's Terminate
    // (abort signal below). A positive timeoutMs opts back into a cap.
    const cap = Number(timeoutMs) > 0 ? clampNum(timeoutMs, 30000, 21600000, 900000) : 0
    let timedOut = false
    let stopped = false
    const kill = () => {
      try {
        child.kill("SIGKILL")
      } catch {
        /* gone */
      }
    }
    // Two ways to bound a stage. A live `getDeadline()` (extendable wall-clock
    // budget) is POLLED so the UI's "+5 min" push takes effect on the RUNNING
    // subprocess; a plain `cap` is the legacy fixed one-shot timer. Deadline wins
    // when both are present.
    let timer = null
    let deadlineTimer = null
    if (typeof getDeadline === "function") {
      deadlineTimer = setInterval(() => {
        const dl = getDeadline()
        if (Number.isFinite(dl) && Date.now() >= dl) {
          timedOut = true
          kill()
        }
      }, 3000)
    } else if (cap > 0) {
      timer = setTimeout(() => {
        timedOut = true
        kill()
      }, cap)
    }
    const clearTimers = () => {
      if (timer) clearTimeout(timer)
      if (deadlineTimer) clearInterval(deadlineTimer)
    }
    const onAbort = () => {
      stopped = true
      kill()
    }
    if (signal) {
      if (signal.aborted) onAbort()
      else signal.addEventListener("abort", onAbort, { once: true })
    }

    let buf = ""
    let stderr = ""
    let finalText = ""
    child.stdout.on("data", (chunk) => {
      buf += chunk.toString("utf8")
      let nl
      while ((nl = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, nl)
        buf = buf.slice(nl + 1)
        if (!line.trim()) continue
        let o
        try {
          o = JSON.parse(line)
        } catch {
          continue
        }
        let stop = false
        try {
          stop = onObject ? onObject(o) : false
        } catch {
          /* observer must never crash the run */
        }
        // Refill the search budget when verify_full_script reports a syntax /
        // unknown-name error — the one case where a lookup is warranted.
        try {
          if (o.type === "assistant" && o.message?.content) {
            for (const c of o.message.content) {
              if (c.type === "tool_use" && String(c.name || "").endsWith("verify_full_script") && c.id) {
                verifyCalls.set(c.id, c.input?.script ?? "")
              }
            }
          } else if (o.type === "user" && o.message?.content) {
            for (const c of o.message.content) {
              if (c.type === "tool_result" && verifyCalls.has(c.tool_use_id)) {
                const t = Array.isArray(c.content)
                  ? c.content.map((x) => x.text || "").join("\n")
                  : String(c.content ?? "")
                // Refill ONLY when a genuine proof attempt hit an unknown name —
                // never for a `#check @guess` probe (that would reward guessing).
                if (verifyTextIsSyntaxError(t) && isRealProofScript(verifyCalls.get(c.tool_use_id))) {
                  grantSearch(governor, "verify syntax error")
                  if (emit)
                    emit({
                      type: "message-annotation",
                      subtype: "status",
                      thought: `${stage ? stage + " " : ""}🔎 Compiler flagged an unknown name — search budget +${GOV_GRANT} (now ${governor.budget}).`,
                    })
                }
              }
            }
          }
        } catch {
          /* budget accounting must never crash the run */
        }
        if (emit) mapObjectToEvents(o, emit, stage, metrics)
        if (o.type === "result") {
          finalText = o.result || finalText
          // Sum this sub-run's cost into the shared tree metrics (ctx.metrics),
          // so the tree's final `done` reports the whole item's actual cost.
          if (metrics && typeof o.total_cost_usd === "number") metrics.cost_usd = (metrics.cost_usd || 0) + o.total_cost_usd
          if (metrics && o.usage) metrics.tokens = (metrics.tokens || 0) + usageTokens(o.usage)
        }
        if (stop && !stopped) {
          stopped = true
          // Interrupt (SIGINT), don't hard-kill: the CLI flushes its final
          // `result` frame on an interrupt, and that frame is the only carrier of
          // total_cost_usd (accumulated into the tree metrics just above). A hard
          // SIGKILL here races that frame and drops the sub-run's cost — the tree
          // equivalent of the flat-path bug. Hard-kill only if it lingers.
          try {
            child.kill("SIGINT")
            setTimeout(kill, PROOF_STOP_GRACE_MS).unref?.()
          } catch {
            /* gone */
          }
        }
      }
    })
    child.stderr.on("data", (c) => {
      stderr += c.toString("utf8")
    })
    child.on("error", (e) => {
      clearTimers()
      if (signal) signal.removeEventListener?.("abort", onAbort)
      destroyGovernor(governor)
      resolve({ ok: false, finalText, exitCode: null, timedOut, stopped, stderr: e.message })
    })
    child.on("close", (code) => {
      clearTimers()
      if (signal) signal.removeEventListener?.("abort", onAbort)
      if (governor.searchCount)
        emit?.({
          type: "message-annotation",
          subtype: "status",
          thought: `${stage ? stage + " " : ""}🔎 Search used ${governor.searchCount}× (${governor.blockedCount} blocked, ${governor.grantCount} refills).`,
        })
      destroyGovernor(governor)
      resolve({ ok: code === 0 && !timedOut, finalText, exitCode: code, timedOut, stopped, stderr })
    })
  })
}

// Prove ONE node's exact statement directly, bounded to ctx.turnBudget turns.
// The gate enforces signature immutability (only a script containing the node's
// exact signature counts). The agent may also volunteer to decompose early by
// emitting a `DECOMPOSE:` line. Returns { verified, proof, decomposeRequested }.
async function runNodeProver(node, ctx) {
  const gate = makeProofGate(node.statement)
  let decomposeRequested = false
  // #2: the node prover's stream already SEES every compile error and tactic
  // state; capture the most recent ones so a forced decomposition can be told
  // exactly where the direct attempt got stuck instead of rediscovering it.
  const verifyIds = new Set()
  let lastVerifyError = ""
  let lastGoalState = ""
  const extra =
    "EARLY DECOMPOSE (optional): if partway through you judge this goal is too large to close directly and would be better split into sub-lemmas, output a line that is exactly `DECOMPOSE: <one-line reason>` and stop — a dedicated decomposition run will then take over. Only do this when genuinely stuck; prefer to finish the proof if you can."
  const prompt = nodePromptFor(ctx.strategy, node.statement, ctx.mcpServers, extra)
  const onObject = (o) => {
    const ev = gate.observe(o)
    if (ev?.verified) return true
    if (o.type === "assistant" && o.message?.content) {
      for (const c of o.message.content) {
        if (c.type === "tool_use" && c.id && String(c.name || "").endsWith("verify_full_script"))
          verifyIds.add(c.id)
        if (c.type === "text" && /(^|\n)\s*DECOMPOSE\s*:/i.test(c.text || "")) {
          decomposeRequested = true
          return true
        }
      }
    } else if (o.type === "user" && o.message?.content) {
      for (const c of o.message.content) {
        if (c.type !== "tool_result") continue
        const t = Array.isArray(c.content)
          ? c.content.map((x) => x?.text || "").join("\n")
          : String(c.content ?? "")
        if (!t) continue
        if (verifyIds.has(c.tool_use_id)) {
          // Keep the latest compile that actually FAILED (not a success line).
          if (!/Compilation Successful|100% verified/i.test(t) && /error|Error|Line \d+|sorry/.test(t))
            lastVerifyError = t
        } else if (/⊢|no goals|goals? \(|state_id|unsolved/i.test(t)) {
          lastGoalState = t // an interactive (Pantograph) tactic state
        }
      }
    }
    return false
  }
  await spawnProverStream(
    {
      prompt,
      mcpServers: ctx.mcpServers,
      model: ctx.model,
      maxTurns: ctx.turnBudget,
      timeoutMs: ctx.nodeTimeoutMs,
      getDeadline: ctx.getDeadline,
      stage: ctx.stage,
      metrics: ctx.metrics,
      signal: ctx.signal,
      searchBudget: ctx.searchBudget,
    },
    { onObject, emit: ctx.emit },
  )
  const proof = gate.verifiedScript
  return { verified: !!proof, proof: proof || "", decomposeRequested, lastVerifyError, lastGoalState }
}

// #2: turn the node prover's captured failure into a decomposer briefing, so it
// targets the exact wall instead of re-deriving it. Empty when nothing useful
// was seen (e.g. the agent never compiled anything).
function nodeFailureContext(res) {
  const clip = (s, n) => {
    const x = String(s || "").trim()
    return x.length > n ? x.slice(0, n) + "\n…(truncated)" : x
  }
  if (res?.lastVerifyError) {
    return `PREVIOUS DIRECT ATTEMPT (do NOT rediscover this — build on it). The last compile of this goal FAILED with:\n${clip(res.lastVerifyError, 1400)}\n\nExtract the SPECIFIC point that failed above into a helper lemma; do not re-split parts that already compiled.`
  }
  if (res?.lastGoalState) {
    return `PREVIOUS DIRECT ATTEMPT (do NOT rediscover this — build on it). The proof advanced but got stuck at this goal state:\n${clip(res.lastGoalState, 1200)}\n\nMake THIS stuck goal your primary helper lemma.`
  }
  return ""
}

// Run the Decomposer subagent on a node, then GATE its output ourselves: take
// the scaffolds it compiled (target-preserving, ≥1 helper), reorder helpers-
// first, and verify each on the daemon. Accept the first that is either a full
// (sorry-free) proof or a structurally-valid reduction. Returns
// { ok, fullyProved?, scaffold, children, reason }.
async function runDecomposer(node, ctx, extraContext = "") {
  const masterName = declaredName(node.statement)
  const verifyCalls = {}
  const candidates = []
  const nearMisses = [] // scaffolds with ≥2 decls but no master-named declaration
  const consider = (script) => {
    if (!script) return
    const decls = extractDeclarations(script)
    const master = decls.find((d) => d.name === masterName)
    const helpers = decls.filter(
      (d) => (d.kind === "theorem" || d.kind === "lemma") && d.name !== masterName,
    )
    // A candidate must keep the master theorem (by name) and add ≥1 helper. Its
    // STATEMENT is checked for drift semantically below, not by string match.
    if (master && helpers.length) candidates.push(script)
    else if (decls.length >= 2) nearMisses.push(decls.map((d) => d.signature))
  }
  const onObject = (o) => {
    if (o.type === "assistant" && o.message?.content) {
      for (const c of o.message.content) {
        if (
          c.type === "tool_use" &&
          String(c.name || "").endsWith("verify_full_script") &&
          c.input &&
          typeof c.input.script === "string"
        ) {
          verifyCalls[c.id] = c.input.script
        }
      }
    } else if (o.type === "user" && o.message?.content) {
      for (const c of o.message.content) {
        if (c.type === "tool_result" && c.tool_use_id && verifyCalls[c.tool_use_id]) {
          consider(verifyCalls[c.tool_use_id])
        }
      }
    }
    return false
  }
  const r = await spawnProverStream(
    {
      prompt: decomposePromptFor(ctx.strategy, node.statement, ctx.mcpServers, extraContext),
      mcpServers: ctx.mcpServers,
      model: ctx.model,
      maxTurns: ctx.decomposeTurnBudget,
      timeoutMs: ctx.nodeTimeoutMs,
      getDeadline: ctx.getDeadline,
      stage: `${ctx.stage}✂️`,
      metrics: ctx.metrics,
      signal: ctx.signal,
      searchBudget: ctx.searchBudget,
    },
    { onObject, emit: ctx.emit },
  )
  // Also consider the final fenced scaffold the run printed.
  consider(extractScript(r.finalText || ""))

  // De-dup, most-recent first, and authoritatively verify up to 3 on the daemon.
  const seen = new Set()
  const uniq = []
  for (const s of candidates.reverse()) {
    const k = normalizeLean(s)
    if (seen.has(k)) continue
    seen.add(k)
    uniq.push(s)
  }
  let sawReductionError = false
  for (const cand of uniq.slice(0, 3)) {
    if (ctx.signal?.aborted) break
    const ordered = normalizeScaffoldOrder(cand, masterName)
    // "Verifying agent didn't drift the goal": rename the agent's restated master
    // and re-prove the TRUE master from it. One daemon compile checks BOTH that
    // the reduction type-checks AND that the goal was not drifted (a drift makes
    // the re-proof error). Same-goal-up-to-defeq (incl. binder renames) passes.
    const guarded = buildDriftGuardScript(ordered, node.statement) || ordered
    ctx.emit({ type: "message-annotation", subtype: "status", thought: `${ctx.stage}🛡️ Verifying agent didn't drift the goal…` })
    const v = await verifyViaDaemon(guarded, ctx.verifyUrl, { timeoutMs: ctx.verifyTimeoutMs })
    const parsed = parseVerifyOutput(v.text)
    if (v.ok && isHoleFreeProof(parsed)) {
      // Fully proved AND goal preserved — `guarded` proves the verbatim master.
      ctx.emit({ type: "message-annotation", subtype: "status", thought: `${ctx.stage}✂️ Goal preserved ✓ — scaffold compiled with no holes; node fully proved.` })
      return { ok: true, fullyProved: true, scaffold: guarded, children: [], reason: "scaffold compiled sorry-free, goal not drifted" }
    }
    if (v.ok && isStructurallyValidDecomposition(parsed)) {
      const helpers = helperDeclarations(ordered, masterName)
      ctx.emit({ type: "message-annotation", subtype: "status", thought: `${ctx.stage}✂️ Goal preserved ✓ — reduces to ${helpers.length} sub-lemma(s).` })
      return { ok: true, scaffold: ordered, children: helpers, reason: `reduces to ${helpers.length} lemma(s)` }
    }
    if (v.ok && parsed.errors.length) {
      sawReductionError = true
      // If the error is the drift guard failing to re-prove the master, the agent
      // changed the goal — surface it distinctly from an ordinary reduction error.
      if (/leakInternalTarget/.test(v.text)) {
        ctx.emit({
          type: "message-annotation",
          subtype: "error",
          thought: `${ctx.stage}🛡️ Goal DRIFTED — the agent's restated theorem does not prove the original. ${oneLine(parsed.errors[0]?.message || "")}`,
        })
      }
    }
  }
  if (!candidates.length && nearMisses.length) {
    // Built a scaffold but no declaration kept the master's NAME — the agent
    // renamed or dropped the master theorem. Surface what it produced instead.
    const produced = nearMisses[nearMisses.length - 1]
    ctx.emit({
      type: "message-annotation",
      subtype: "error",
      thought: `${ctx.stage}✂️ Scaffold dropped the master theorem "${masterName}".\n  produced: ${produced.map(oneLine).join("\n            ")}`,
    })
  }
  return {
    ok: false,
    reason: sawReductionError
      ? "no candidate preserved the goal AND reduced it cleanly (drift or a real type error remained)"
      : candidates.length
        ? "the reduction did not compile"
        : nearMisses.length
          ? `decomposer dropped/renamed the master theorem "${masterName}" — it must keep it verbatim`
          : "decomposer produced no scaffold containing the master theorem",
  }
}

// Recursively prove one node. Sound invariant: nothing is accepted until an
// assembled, sorry-free script that CONTAINS this node's exact signature passes
// the daemon. Everything else is heuristic to get there.
async function proveNode(node, ctx) {
  if (ctx.signal?.aborted) return false
  if (ctx.nodeCount >= ctx.maxNodes) {
    node.status = "failed"
    ctx.emit({ type: "message-annotation", subtype: "error", thought: `⛔ Node budget (${ctx.maxNodes}) exhausted — stopping.` })
    return false
  }
  ctx.nodeCount++
  const label = node.depth === 0 ? "root" : `depth ${node.depth}`
  ctx.stage = `🌳[${label}]`
  ctx.emit({ type: "message-annotation", subtype: "status", thought: `🌳 Proving (${label}): ${oneLine(node.signature)}` })

  // 1. Bounded direct attempt.
  const res = await runNodeProver(node, ctx)
  if (res.verified) {
    node.proof = res.proof
    node.status = "proved-direct"
    ctx.emit({ type: "message-annotation", subtype: "status", thought: `✅ Closed directly (${label}): ${declName(node.signature)}` })
    return true
  }
  if (ctx.signal?.aborted) return false
  if (node.depth >= ctx.maxDepth) {
    node.status = "failed"
    ctx.emit({ type: "message-annotation", subtype: "error", thought: `⛔ Max depth (${ctx.maxDepth}) reached; cannot decompose ${declName(node.signature)} further.` })
    return false
  }

  // 2-4. Decompose → prove children → assemble, wrapped in a bounded
  // RE-DECOMPOSITION retry (#5): if a child lemma turns out unprovable, or the
  // assembly won't verify, the split was probably flawed — try a DIFFERENT
  // decomposition instead of instantly killing the whole branch. The node
  // prover's failure context (#2) seeds the first decompose; each retry also
  // states why the last split failed so the decomposer doesn't repeat it.
  const maxRetry = Number.isFinite(ctx.maxRedecompose) ? ctx.maxRedecompose : 1
  const baseContext = nodeFailureContext(res)
  let extraContext = baseContext
  for (let attempt = 0; ; attempt++) {
    if (ctx.signal?.aborted) return false
    ctx.emit({
      type: "message-annotation",
      subtype: "status",
      thought:
        attempt > 0
          ? `♻️ Re-decomposing ${declName(node.signature)} (attempt ${attempt + 1}) — the previous split didn't pan out.`
          : res.decomposeRequested
            ? `🪓 Agent requested decomposition of ${declName(node.signature)}.`
            : `🪓 Not closed in ${ctx.turnBudget} turns — forcing decomposition of ${declName(node.signature)}.`,
    })
    const dec = await runDecomposer(node, ctx, extraContext)
    if (!dec.ok) {
      if (attempt < maxRetry && ctx.nodeCount < ctx.maxNodes && !ctx.signal?.aborted) {
        extraContext = `${baseContext}\n\nA previous decomposition attempt did not yield a usable split (${dec.reason}). Produce a DIFFERENT decomposition.`
        continue
      }
      node.status = "failed"
      ctx.emit({ type: "message-annotation", subtype: "error", thought: `❌ Decomposition failed: ${dec.reason}` })
      return false
    }
    if (dec.fullyProved) {
      node.proof = dec.scaffold
      node.status = "proved-direct"
      ctx.emit({ type: "message-annotation", subtype: "status", thought: `✅ Decomposer fully proved ${declName(node.signature)}.` })
      return true
    }
    node.scaffold = dec.scaffold
    node.children = dec.children.map((h, i) => ({
      id: `${node.id}.${i + 1}`,
      signature: h.signature,
      statement: h.text,
      status: "open",
      children: [],
      depth: node.depth + 1,
    }))
    node.status = "decomposed"
    const childNames = node.children.map((c) => declName(c.signature)).join(", ")
    ctx.emit({
      type: "message-annotation",
      subtype: "status",
      thought: `➗ Split ${declName(node.signature)} into ${node.children.length} lemma(s): ${childNames}`,
    })

    // 3. Recurse into every child; a single unproved child dooms THIS split.
    let failReason = ""
    for (const child of node.children) {
      const ok = await proveNode(child, ctx)
      if (!ok) {
        failReason = `sub-lemma "${declName(child.signature)}" could not be proved`
        break
      }
    }

    // 4. If every child proved, assemble the subtree and GATE it by re-proving
    // the node's exact statement from the assembly ("verifying agent didn't
    // drift the goal"). The guarded script, when hole-free, is itself a proof of
    // the VERBATIM master — benign warnings tolerated, only errors/sorry are
    // holes. Falls back to a plain hole-free + canonical-signature check.
    if (!failReason) {
      if (ctx.signal?.aborted) return false
      const assembled = assembleScript(node)
      ctx.emit({ type: "message-annotation", subtype: "status", thought: `🧩 Assembling ${declName(node.signature)} from ${node.children.length} proved lemma(s) — 🛡️ verifying no goal drift…` })
      const guarded = buildDriftGuardScript(assembled, node.statement)
      if (guarded) {
        const gv = await verifyViaDaemon(guarded, ctx.verifyUrl, { timeoutMs: ctx.verifyTimeoutMs })
        if (gv.ok && isHoleFreeProof(parseVerifyOutput(gv.text))) {
          node.proof = guarded
          node.status = "proved-assembled"
          ctx.emit({ type: "message-annotation", subtype: "status", thought: `🧩 ${declName(node.signature)} assembled; goal preserved and verified hole-free.` })
          return true
        }
      }
      const v = await verifyViaDaemon(assembled, ctx.verifyUrl, { timeoutMs: ctx.verifyTimeoutMs })
      const parsed = parseVerifyOutput(v.text)
      if (v.ok && isHoleFreeProof(parsed) && scriptProvesTarget(assembled, node.signature)) {
        node.proof = assembled
        node.status = "proved-assembled"
        ctx.emit({ type: "message-annotation", subtype: "status", thought: `🧩 ${declName(node.signature)} assembled and verified sorry-free.` })
        return true
      }
      failReason = `assembly did not verify (${oneLine(v.text || v.error || "unknown")})`
    }

    // A child or the assembly failed. Re-decompose with a DIFFERENT split if we
    // still have retry budget AND node budget; else the node fails for real.
    if (attempt < maxRetry && ctx.nodeCount < ctx.maxNodes && !ctx.signal?.aborted) {
      ctx.emit({ type: "message-annotation", subtype: "status", thought: `♻️ ${declName(node.signature)}: ${failReason} — re-decomposing with a different split.` })
      extraContext = `${baseContext}\n\nA PREVIOUS decomposition of THIS goal FAILED: it split into [${childNames}] but ${failReason}. Produce a DIFFERENT decomposition — change the lemma boundaries or the mathematical approach; do NOT repeat that same split.`
      node.children = []
      node.scaffold = undefined
      node.status = "open"
      continue
    }
    node.status = "failed"
    ctx.emit({ type: "message-annotation", subtype: "error", thought: `❌ ${declName(node.signature)}: ${failReason}.` })
    return false
  }
}

// HAVE-mode orchestration (the `have` style): a single agent proves the master
// in ONE context, decomposing via local `have`s — no tree, no cross-agent
// hand-off, no top-level-binder re-generalization. Same soundness bar as the
// tree: the agent's self-reported success is RE-VERIFIED independently on the
// daemon before acceptance. Bounded outer retries feed the last compile failure
// back in (like #2) so a stuck run gets a fresh, informed attempt.
async function proveHaveFlat(theorem, ctx, { seed, hints } = {}) {
  const maxRetry = Number.isFinite(ctx.maxRedecompose) ? ctx.maxRedecompose : 1
  // When the have-tree banked some holes, it hands us the partially-filled
  // skeleton here so that proven work is never thrown away — the agent only has
  // to finish the remaining `sorry`s. This is a soft HINT (the agent may still
  // restructure); the independent verify gate below is unchanged, so soundness
  // is identical to a from-scratch run.
  const seedNote = seed
    ? `A PARTIAL PROOF is already on the board. In the skeleton below, every \`have\` step whose body is NOT \`sorry\` is ALREADY PROVEN and correct — reuse it verbatim, do NOT redo it. Your ONLY job is to fill the remaining \`sorry\` hole(s) and output the complete, sorry-free proof of the master:\n\`\`\`lean\n${seed}\n\`\`\`\n`
    : ""
  // Unverified scratch work from isolated minions that didn't bank their hole:
  // the tactics they applied in the interactive prover (since wiped). A pure
  // HINT — the agent may reuse correct steps or ignore dead ends. Soundness is
  // unchanged (the verify gate below still demands a full, independent proof).
  const hintNote =
    hints && Object.keys(hints).length
      ? "\nUNVERIFIED SCRATCH WORK from isolated attempts on the remaining hole(s) — reuse any step that is correct, ignore dead ends:\n" +
        Object.entries(hints)
          .map(([id, n]) => {
            const tac = (n?.tactics || [])
              .map((t) => "    " + String(t).replace(/\s+/g, " ").slice(0, 160))
              .join("\n")
            return `  ⟪${id}⟫${tac ? " applied these tactics, in order:\n" + tac : ""}`
          })
          .join("\n") + "\n"
      : ""
  let extra = ""
  for (let attempt = 0; ; attempt++) {
    if (ctx.signal?.aborted) return { verified: false, proof: "" }
    ctx.stage = "🧩"
    ctx.emit({
      type: "message-annotation",
      subtype: "status",
      thought:
        attempt > 0
          ? `♻️ Retrying have-based proof (attempt ${attempt + 1}) with the last compile error in hand.`
          : seed
            ? `🧩 Finishing the remaining hole(s) in one context — the already-proven steps are kept (${remainingLabel(ctx)}).`
            : `🧩 Proving in one context via local \`have\` decomposition (${remainingLabel(ctx)}).`,
    })
    const gate = makeProofGate(theorem)
    const verifyIds = new Set()
    let lastVerifyError = ""
    const onObject = (o) => {
      const ev = gate.observe(o)
      if (ev?.verified) return true
      if (o.type === "assistant" && o.message?.content) {
        for (const c of o.message.content) {
          if (c.type === "tool_use" && c.id && String(c.name || "").endsWith("verify_full_script")) verifyIds.add(c.id)
        }
      } else if (o.type === "user" && o.message?.content) {
        for (const c of o.message.content) {
          if (c.type !== "tool_result" || !verifyIds.has(c.tool_use_id)) continue
          const t = Array.isArray(c.content) ? c.content.map((x) => x?.text || "").join("\n") : String(c.content ?? "")
          if (t && !/Compilation Successful|100% verified/i.test(t) && /error|Error|Line \d+|sorry/.test(t)) lastVerifyError = t
        }
      }
      return false
    }
    await spawnProverStream(
      {
        prompt: haveProvePrompt(theorem, ctx.mcpServers, `${seedNote}${hintNote}${extra}`),
        mcpServers: ctx.mcpServers,
        model: ctx.model,
        // NO turn cap. The finisher runs until it proves the goal or the SHARED
        // wall-clock deadline (ctx.getDeadline, extendable via the "+5 min" button)
        // kills it — TIME is the only governor, exactly like the single-agent path.
        maxTurns: 0,
        timeoutMs: ctx.nodeTimeoutMs,
        getDeadline: ctx.getDeadline,
        stage: ctx.stage,
        metrics: ctx.metrics,
        signal: ctx.signal,
        searchBudget: ctx.searchBudget,
      },
      { onObject, emit: ctx.emit },
    )
    const candidate = gate.verifiedScript
    if (candidate) {
      ctx.emit({ type: "message-annotation", subtype: "status", thought: "🛡️ Re-verifying the have-based proof independently on the daemon…" })
      const v = await verifyViaDaemon(candidate, ctx.verifyUrl, { timeoutMs: ctx.verifyTimeoutMs })
      if (v.ok && isHoleFreeProof(parseVerifyOutput(v.text)) && scriptProvesTarget(candidate, theoremSignature(theorem)))
        return { verified: true, proof: candidate }
      ctx.emit({ type: "message-annotation", subtype: "error", thought: `⚠️ Agent reported success but the independent re-verify did not confirm it: ${oneLine(v.text || v.error || "unknown")}` })
    }
    // When a compute budget is set the run is TIME-governed (like the single-agent
    // path): keep retrying until the SHARED deadline or a Terminate — NOT a fixed
    // attempt count — so extending the clock ("+5 min"/"+1h") actually buys more
    // attempts instead of stopping early with budget to spare. Uncapped runs (no
    // budget ⇒ Infinite deadline) keep the finite maxRetry so they can't loop
    // forever. Every retry re-verifies independently, so soundness is unchanged.
    const outOfAttempts = ctx.computeGoverned ? false : attempt >= maxRetry
    if (outOfAttempts || ctx.signal?.aborted || deadlinePassed(ctx)) return { verified: false, proof: "" }
    extra = lastVerifyError
      ? `YOUR PREVIOUS ATTEMPT FAILED. The last verify_full_script reported:\n${lastVerifyError.slice(0, 1400)}\n\nFix the SPECIFIC error above — adjust the failing \`have\` or the final assembly, and keep the parts that already compiled.`
      : "YOUR PREVIOUS ATTEMPT did not produce a verified proof. Start from the skeleton-first approach: lay out the `have`s, compile the skeleton, then fill them."
  }
}

// ---------------------------------------------------------------------------
// HAVE-TREE — Phase-1 linear-context orchestrator.
// The single-agent `have` mode (proveHaveFlat) holds the WHOLE proof in ONE
// context, so context grows ~O(N²) with proof length and the model degrades. The
// have-tree keeps every agent's context BOUNDED: a PLANNER writes a compiled
// `have`-skeleton (each hard step a hole `:= by sorry --⟪hN⟫`), then each hole is
// filled by a FRESH, ISOLATED MINION that sees only the skeleton — i.e. the
// sibling SIGNATURES, never their proofs — and the ASSEMBLER splices the fills
// and re-checks the whole thing hole-free on the daemon. Cost scales with the
// number of holes, not proof length.
//   Q1 (per-hole goal state): the minion is handed the skeleton — the have's TYPE
//     is its goal and the earlier `have`s are its hypotheses; it can init_proof
//     that goal to see the exact state on demand.
//   Q2 (relevant context): the whole (small) skeleton, which carries Lean's real
//     scoping — no lossy pruning that could drop a needed hypothesis.
//   Q3 (teardown): each minion is a separate process; when it returns its fill,
//     the process exits and its context evaporates — only the fill (a few
//     tactics) survives, spliced into the file.
// SAFETY: anything that goes wrong (no skeleton, an unfillable hole, a stitched
// proof that doesn't verify) FALLS BACK to proveHaveFlat, so have-tree is never
// weaker than the known-good single-context path.
// ---------------------------------------------------------------------------
const HOLE_TAG_RE = /--\s*⟪\s*(\w+)\s*⟫/g
const HAS_HOLE_TAG = /--\s*⟪\s*\w+\s*⟫/ // non-global, for safe boolean tests

function parseHoleIds(skeleton) {
  const ids = []
  const seen = new Set()
  const src = String(skeleton || "")
  HOLE_TAG_RE.lastIndex = 0
  let m
  while ((m = HOLE_TAG_RE.exec(src)) !== null) {
    if (!seen.has(m[1])) {
      seen.add(m[1])
      ids.push(m[1])
    }
  }
  return ids
}

// Extract the tactic block a minion emitted for hole `id`: the ```lean fence that
// follows its `FILL ⟪id⟫` marker. Strict on purpose — a malformed reply yields
// null → the hole fails → we fall back, rather than splicing garbage.
function parseFillBlock(text, id) {
  const s = String(text || "")
  const re = new RegExp("FILL\\s*⟪\\s*" + id + "\\s*⟫[\\s\\S]*?```lean\\s*\\n([\\s\\S]*?)```", "i")
  const m = s.match(re)
  if (!m) return null
  const body = m[1].replace(/\s+$/, "")
  return body.trim() ? body : null
}

// A minion's DECOMPOSE reply: a nested `have`-block (with its own tagged holes)
// that reduces hole `id`. Returns the lean body, or null if absent / has no new
// holes (a decomposition with no sub-holes is just a fill — reject it here so it
// isn't spliced as a dead sub-tree).
function parseDecomposeBlock(text, id) {
  const s = String(text || "")
  const re = new RegExp("DECOMPOSE\\s*⟪\\s*" + id + "\\s*⟫[\\s\\S]*?```lean\\s*\\n([\\s\\S]*?)```", "i")
  const m = s.match(re)
  if (!m) return null
  const body = m[1].replace(/\s+$/, "")
  if (!body.trim() || !HAS_HOLE_TAG.test(body)) return null
  return body
}

// Rewrite every `--⟪x⟫` tag in a sub-decomposition to a globally-unique id (not
// already present in `existing`), so nested holes can never collide with holes
// elsewhere in the tree. Returns { body, tags }.
let TAG_SEQ = 0
function freshenTags(body, existing) {
  const seen = new Set(existing)
  const map = new Map()
  const out = String(body).replace(/⟪\s*(\w+)\s*⟫/g, (_, t) => {
    if (!map.has(t)) {
      let nt
      do {
        nt = `d${++TAG_SEQ}`
      } while (seen.has(nt))
      seen.add(nt)
      map.set(t, nt)
    }
    return `⟪${map.get(t)}⟫`
  })
  return { body: out, tags: [...map.values()] }
}

// Replace hole `id`'s `:= by sorry --⟪id⟫` with the minion's tactics, re-indented
// under the `have`. Returns the skeleton unchanged if the hole's shape is
// unexpected (the final assembly verify then catches the leftover sorry).
function spliceHole(skeleton, id, tactics) {
  const lines = String(skeleton || "").split("\n")
  const markRe = new RegExp("--\\s*⟪\\s*" + id + "\\s*⟫")
  const idx = lines.findIndex((l) => markRe.test(l))
  if (idx < 0) return skeleton
  const line = lines[idx]
  const bodyRe = new RegExp(":=\\s*by\\s+sorry\\s*--\\s*⟪\\s*" + id + "\\s*⟫\\s*$")
  if (!bodyRe.test(line)) return skeleton
  const ind = (line.match(/^\s*/) || [""])[0].length
  const pad = " ".repeat(ind + 2)
  const body = String(tactics)
    .split("\n")
    .map((t) => (t.trim() === "" ? "" : pad + t))
    .join("\n")
  lines[idx] = line.replace(bodyRe, ":= by\n" + body)
  return lines.join("\n")
}

function haveTreePlannerPrompt(theorem, mcpServers = [], extra = "") {
  const toolSection = mcpToolSection(mcpServers)
  return `You are the PLANNER for a Lean 4 + Mathlib proof. Your job is to produce a STRUCTURALLY VALID SKELETON that another agent will fill — NOT to finish the proof.

${toolSection}

${RESEARCH_MODE_NOTE}

TWO OUTCOMES — pick the cheaper one (there is NO third "too hard" option — if you can't close it outright, you DECOMPOSE):
A) If you can close the whole theorem OUTRIGHT in roughly ≤ 40 lines, just do it: write the proof, verify_full_script it to success (no \`sorry\`), and output it as one \`\`\`lean block. Done.
B) Otherwise, DECOMPOSE into a skeleton and STOP (do NOT fill the holes):
   1. Reproduce the ORIGINAL theorem VERBATIM (same name + signature), open with \`by\`.
   2. Lay the argument out as local steps, each a HOLE written EXACTLY like this, on ONE line:
        have hN : <the proposition for this step> := by sorry --⟪hN⟫
      Use a DISTINCT tag per hole: --⟪h1⟫, --⟪h2⟫, …. The \`have\` inherits the ambient hypotheses automatically — do NOT re-quantify. Each hole must be a genuinely SMALLER step, ideally closable on its own in ≤ ~40 lines.
   3. Close the main goal FROM those \`have\`s. This ASSEMBLY must be \`sorry\`-FREE — the ONLY holes in the whole script are the tagged \`have … := by sorry --⟪hN⟫\` lines.
   4. verify_full_script the skeleton: it MUST compile with the ONLY diagnostics being \`sorry\` warnings (no errors). That proves the decomposition type-checks. Deprecation/linter warnings are fine.
   5. STOP. Output the verified skeleton as one \`\`\`lean block. Do NOT fill any hole.

RULES:
- Every hole tag must be unique and match \`--⟪hN⟫\` EXACTLY (double angle brackets). Hole bodies are a single \`:= by sorry --⟪hN⟫\`.
- No top-level \`theorem\`/\`lemma\` other than the master; all structure is \`have\`s.
- A skeleton whose assembly still has a bare \`sorry\`, or whose holes aren't tagged, is INVALID — fix it before stopping.

${SEARCH_USAGE_NOTE}
${extra ? `\n${extra}\n` : ""}
Theorem (its signature is immutable):
${theorem}`
}

function haveHoleFillPrompt(skeleton, id, mcpServers = [], extra = "") {
  const toolSection = mcpToolSection(mcpServers)
  return `You are a MINION working ONE hole in a Lean 4 proof skeleton. Do NOT touch any other hole.

${toolSection}

${RESEARCH_MODE_NOTE}

THE SKELETON (already compiles with every \`have\` stubbed as \`sorry\`):
\`\`\`lean
${skeleton}
\`\`\`

YOUR HOLE: the \`have\` tagged \`--⟪${id}⟫\`. Its declared type is your GOAL; the hypotheses in scope are the theorem's binders plus the EARLIER \`have\`s (they're available by name). To see the EXACT goal state, \`init_proof\` your hole's proposition (closed: ∀-quantify any free variable) and step it with \`apply_tactic\` — lead with strong automation (\`decide\`, \`native_decide\`, \`omega\`, \`simp_all\`, \`nlinarith\`, \`induction\`).

You have TWO ways to make progress — you must ALWAYS produce one of them, never nothing:

CLOSE — if you can finish the hole, work out the tactics and CHECK them: take the skeleton, replace ONLY \`sorry --⟪${id}⟫\` with your tactics (leave every other \`sorry --⟪…⟫\` untouched), verify_full_script until it compiles with only the OTHER holes' \`sorry\` warnings and NO errors. Then output:
FILL ⟪${id}⟫
\`\`\`lean
<only the tactics that replace \`sorry\`, one per line, from the LEFT margin — no \`have\`, no leading \`by\`, no theorem>
\`\`\`

DECOMPOSE — if the hole resists a direct close, do NOT give up: break its goal into SMALLER sub-steps that another minion will fill. Write local \`have\`s (they inherit this hole's context automatically — do NOT re-quantify), each a NEW tagged hole, then close THIS hole's goal from them. CHECK it by splicing in place of \`sorry --⟪${id}⟫\` and verify_full_script — it MUST compile with only \`sorry\` warnings (the new ones plus the untouched others), NO errors. Then output:
DECOMPOSE ⟪${id}⟫
\`\`\`lean
have s1 : <smaller subgoal> := by sorry --⟪s1⟫
have s2 : <smaller subgoal> := by sorry --⟪s2⟫
<tactics that close THIS hole's goal from s1, s2, …>
\`\`\`
Each sub-step must be a GENUINELY smaller/easier goal. Use fresh tags (s1, s2, …); the system renames them to stay unique. Prefer CLOSE; DECOMPOSE only when you can't close directly — but ALWAYS pick one, never report that it's impossible.
(You do NOT need to call cleanup_memory — the system frees proof state between holes for you. Spend your turns proving.)

${SEARCH_USAGE_NOTE}
${extra ? `\n${extra}\n` : ""}`
}

// Work one hole in an isolated minion (fresh process → bounded context). Returns
// EITHER a tactic fill (closes the hole), a decomposition (nested sub-skeleton
// that reduces it to smaller holes), or a fail with scratch notes.
async function fillHole(skeleton, id, ctx) {
  if (ctx.signal?.aborted) return { fill: null, decompose: null, notes: null }
  ctx.emit({ type: "message-annotation", subtype: "status", thought: `🧩 Minion working hole ⟪${id}⟫ in an isolated context…` })
  // Collect the tactics the minion actually applied, so a REJECTED minion's
  // work can seed the combined finish rather than evaporating with its (soon
  // wiped) Pantograph state.
  const applied = []
  const res = await spawnProverStream(
    {
      prompt: haveHoleFillPrompt(skeleton, id, ctx.mcpServers, ""),
      mcpServers: ctx.mcpServers,
      model: ctx.model,
      // NO turn cap. A minion runs until it fills its hole or the SAME shared
      // wall-clock deadline the main thread uses (ctx.getDeadline, extendable via
      // "+5 min") kills it. Minions and the main thread share ONE clock.
      maxTurns: 0,
      timeoutMs: ctx.nodeTimeoutMs,
      getDeadline: ctx.getDeadline,
      stage: `⟪${id}⟫`,
      metrics: ctx.metrics,
      signal: ctx.signal,
      searchBudget: ctx.searchBudget,
    },
    {
      onObject: (o) => {
        if (o?.type === "assistant" && Array.isArray(o.message?.content)) {
          for (const c of o.message.content) {
            if (c?.type === "tool_use" && String(c.name || "").endsWith("apply_tactic") && c.input?.tactic)
              applied.push(String(c.input.tactic))
          }
        }
        return false
      },
      emit: ctx.emit,
    },
  )
  const fill = parseFillBlock(res.finalText, id)
  if (fill) return { fill, decompose: null, notes: null }
  const decompose = parseDecomposeBlock(res.finalText, id)
  if (decompose) return { fill: null, decompose, notes: null }
  ctx.emit({ type: "message-annotation", subtype: "error", thought: `⚠️ Hole ⟪${id}⟫ minion returned no usable FILL/DECOMPOSE block.` })
  return { fill: null, decompose: null, notes: { text: (res.finalText || "").slice(-800), tactics: applied.slice(-24) } }
}

// Phase-1 orchestrator. Planner → isolated per-hole minions → assembler, with a
// hard fall-through to proveHaveFlat so it can never be weaker than today.
async function proveHaveTree(theorem, ctx) {
  if (ctx.signal?.aborted) return { verified: false, proof: "" }
  const sig = theoremSignature(theorem)
  ctx.stage = "🌿"
  ctx.emit({ type: "message-annotation", subtype: "status", thought: "🌿 Have-tree: planning a decomposition skeleton (isolated per-hole minions)." })

  // ---- 1) PLANNER: a hole-free proof (small case) OR a tagged skeleton --------
  const gate = makeProofGate(theorem)
  const verifyScripts = new Map()
  let skeleton = null
  const onPlan = (o) => {
    const ev = gate.observe(o)
    if (ev?.verified) return true // planner closed it outright — stop
    try {
      if (o.type === "assistant" && o.message?.content) {
        for (const c of o.message.content) {
          if (c.type === "tool_use" && c.id && String(c.name || "").endsWith("verify_full_script")) verifyScripts.set(c.id, c.input?.script ?? "")
        }
      } else if (o.type === "user" && o.message?.content) {
        for (const c of o.message.content) {
          if (c.type !== "tool_result" || !verifyScripts.has(c.tool_use_id)) continue
          const script = verifyScripts.get(c.tool_use_id)
          const t = Array.isArray(c.content) ? c.content.map((x) => x?.text || "").join("\n") : String(c.content ?? "")
          const parsed = parseVerifyOutput(t)
          if (isStructurallyValidDecomposition(parsed) && scriptProvesTarget(script, sig) && HAS_HOLE_TAG.test(script)) {
            skeleton = script // keep the latest valid, tagged skeleton
          }
        }
      }
    } catch {
      /* observation must never crash the run */
    }
    return false
  }
  await spawnProverStream(
    {
      prompt: haveTreePlannerPrompt(theorem, ctx.mcpServers),
      mcpServers: ctx.mcpServers,
      model: ctx.model,
      // NO turn cap. The planner writes its skeleton and stops naturally; if it
      // stalls, the shared wall-clock deadline (ctx.getDeadline) bounds it.
      maxTurns: 0,
      timeoutMs: ctx.nodeTimeoutMs,
      getDeadline: ctx.getDeadline,
      stage: "🌿",
      metrics: ctx.metrics,
      signal: ctx.signal,
      searchBudget: ctx.searchBudget,
    },
    { onObject: onPlan, emit: ctx.emit },
  )

  // Small-proof fast path: the planner closed it directly.
  if (gate.verifiedScript) {
    const v = await verifyViaDaemon(gate.verifiedScript, ctx.verifyUrl, { timeoutMs: ctx.verifyTimeoutMs })
    if (v.ok && isHoleFreeProof(parseVerifyOutput(v.text)) && scriptProvesTarget(gate.verifiedScript, sig)) {
      ctx.emit({ type: "message-annotation", subtype: "status", thought: "✅ Planner closed it directly (under the split ceiling)." })
      return { verified: true, proof: gate.verifiedScript }
    }
  }

  if (ctx.signal?.aborted) return { verified: false, proof: "" }
  if (!skeleton) {
    ctx.emit({ type: "message-annotation", subtype: "status", thought: "↩︎ No valid tagged skeleton — falling back to single-context have mode." })
    return proveHaveFlat(theorem, ctx)
  }
  const holeIds = parseHoleIds(skeleton)
  if (!holeIds.length) return proveHaveFlat(theorem, ctx)
  ctx.emit({ type: "message-annotation", subtype: "status", thought: `🌿 Skeleton verified — ${holeIds.length} hole(s): ${holeIds.map((h) => `⟪${h}⟫`).join(" ")}. Filling each in its own minion.` })
  // First resumable checkpoint: the verified skeleton itself. Even with 0 holes
  // filled this is worth saving — a resume from here skips the whole planning
  // phase. Client persists the latest checkpoint; any stop can restart here.
  ctx.emit({ type: "checkpoint", skeleton, filled: 0, total: holeIds.length })

  // ---- 2) MINIONS: fill each hole in its OWN isolated context, SEQUENTIALLY ----
  // Sequential, not parallel: Leak II's cleanup_memory is GLOBAL, so concurrent
  // minions clobber each other's proof states. The bridge frees state BETWEEN
  // minions instead (the minion prompt no longer calls cleanup_memory), so each
  // minion still gets a clean daemon without racing the others.
  const pantoUrl = resolvePantographUrl(ctx.mcpServers)
  // ---- 2) RECURSIVE DECOMPOSITION over ONE evolving skeleton --------------------
  // Iterative deepening: each round walks the OPEN holes; a minion either CLOSES a
  // hole (splice tactics), SPLITS it (splice a verified nested sub-skeleton → new
  // smaller holes for the next round), or fails (leave it for the finisher). This
  // is the recursion — a resisting hole becomes smaller holes instead of a dead
  // end. Bounded by MAX_DECOMP_DEPTH and the shared wall-clock; every splice
  // re-emits a resumable checkpoint so banked progress survives any stop.
  let partial = skeleton
  const rejectedNotes = {} // hole id -> scratch notes handed to the finisher
  const stuck = new Set() // holes we tried and could not advance (skip on re-walk)
  let banked = 0
  for (let depth = 0; depth < MAX_DECOMP_DEPTH; depth++) {
    if (ctx.signal?.aborted || deadlinePassed(ctx)) break
    const open = parseHoleIds(partial).filter((h) => !stuck.has(h))
    if (!open.length) break
    let progressed = false
    for (const id of open) {
      if (ctx.signal?.aborted || deadlinePassed(ctx)) break
      const r = await fillHole(partial, id, ctx)
      if (r.fill != null) {
        partial = spliceHole(partial, id, r.fill)
        banked++
        progressed = true
        ctx.emit({ type: "message-annotation", subtype: "status", thought: `✅ Banked hole ⟪${id}⟫.` })
      } else if (r.decompose && depth + 1 < MAX_DECOMP_DEPTH) {
        // Rename sub-holes to globally-unique tags, splice the nested block in
        // place of this hole, and ACCEPT only if the whole script still compiles
        // with only `sorry` warnings and still proves the master. Else leave it.
        const { body: freshBody, tags } = freshenTags(r.decompose, parseHoleIds(partial))
        const trial = spliceHole(partial, id, freshBody)
        const v = await verifyViaDaemon(trial, ctx.verifyUrl, { timeoutMs: ctx.verifyTimeoutMs })
        if (v.ok && isStructurallyValidDecomposition(parseVerifyOutput(v.text)) && scriptProvesTarget(trial, sig)) {
          partial = trial
          progressed = true
          ctx.emit({ type: "message-annotation", subtype: "status", thought: `🌿 Split hole ⟪${id}⟫ into ${tags.length} smaller hole(s): ${tags.map((t) => `⟪${t}⟫`).join(" ")}.` })
        } else {
          stuck.add(id)
          if (r.notes) rejectedNotes[id] = r.notes
          ctx.emit({ type: "message-annotation", subtype: "error", thought: `↩︎ Hole ⟪${id}⟫ split didn't type-check — leaving it for the finisher.` })
        }
      } else {
        stuck.add(id)
        if (r.notes) rejectedNotes[id] = r.notes
      }
      const openNow = parseHoleIds(partial)
      ctx.emit({ type: "checkpoint", skeleton: partial, filled: banked, total: banked + openNow.length })
      if (pantoUrl)
        await callRemoteMcpTool(pantoUrl, /cleanup.*memory|cleanup_memory/i, {}, { timeoutMs: 15000 }).catch(() => {})
    }
    if (!progressed) break // a full round advanced nothing → hand the residual on
  }

  // ---- 3) The evolving skeleton IS the banked partial. Any still-open holes go to
  // the finisher; a fully-closed one is the outright win.
  const remaining = parseHoleIds(partial)
  const filled = banked

  if (remaining.length === 0 && !ctx.signal?.aborted) {
    // Every hole filled — assemble + verify hole-free (the full win).
    ctx.emit({ type: "message-annotation", subtype: "status", thought: "🛡️ All holes filled — assembling and re-verifying the whole proof on the daemon…" })
    const v = await verifyViaDaemon(partial, ctx.verifyUrl, { timeoutMs: ctx.verifyTimeoutMs })
    if (v.ok && isHoleFreeProof(parseVerifyOutput(v.text)) && scriptProvesTarget(partial, sig)) {
      ctx.emit({ type: "message-annotation", subtype: "status", thought: `✅ Have-tree assembled a verified proof from ${filled} banked hole(s) (recursive decomposition).` })
      return { verified: true, proof: partial }
    }
    ctx.emit({ type: "message-annotation", subtype: "error", thought: `↩︎ Stitched proof didn't verify (${oneLine(v.text || v.error || "unknown")}) — finishing from the filled skeleton in one context.` })
  } else if (!ctx.signal?.aborted) {
    ctx.emit({ type: "message-annotation", subtype: "status", thought: `🌿 Banked ${filled}/${filled + remaining.length} hole(s); finishing ${remaining.map((h) => `⟪${h}⟫`).join(" ")} in one context.` })
  }

  // ---- 4) FINISH: hand the PARTIALLY-filled skeleton to flat mode as a seed, so
  // the proven holes are never thrown away. Flat mode's gate still requires a
  // full, independently-verified proof of the master, so soundness is unchanged.
  if (ctx.signal?.aborted) return { verified: false, proof: "" }
  return proveHaveFlat(theorem, ctx, { seed: partial, hints: rejectedNotes })
}

// ===========================================================================
// ARCHITECT — Goedel-Architect pipeline (arXiv 2606.06468), style: "architect"
// ---------------------------------------------------------------------------
// Faithful replication of the paper's three-stage loop on the Leak stack:
//
//   1. BLUEPRINT GENERATION — one model conversation emits a dependency graph
//      of `@[blueprint]` declarations (LeanArchitect syntax, bodies
//      `:= by sorry_using [deps]`), iterating against Leak XII's lean_compile
//      gate (structural safeguards → Lean compile → graph validation) until
//      "Compilation SUCCESSFUL. Validation SUCCESSFUL."
//   2. THEOREM PROVING — every unsolved node is dispatched to a FRESH, ISOLATED
//      prover conversation in parallel. A node prover sees ONLY its lemma and
//      its declared parents' signatures (the paper's context discipline — no
//      global transcript, no sibling proofs). Outcomes: solved, formally
//      negated (compiler-corroborated disproof), or a structured forfeit
//      (## Diagnosis / ## Analysis / ## Suggested Fix).
//   3. BLUEPRINT REFINEMENT — a fresh conversation reads the annotated graph
//      (decls + `-- PROVED`/`-- UNPROVED` markers + per-failure Diagnosis
//      blocks — compact signals, never transcripts) and emits a revised
//      blueprint. Proved nodes carry their proofs forward as long as their
//      signature is byte-identical (modulo whitespace). Loop ≤ 8 iterations.
//
// The driver is xAI's Grok (default grok-4.1 fast tier — the closest open
// analogue to the paper's DeepSeek-V4-Flash backbone), spoken to directly
// over the OpenAI-compatible chat/completions API with function calling.
// No Claude CLI is involved on this path.
//
// Budgets (paper Appendix A): blueprint 262,144 tokens/attempt, ≤8 attempts;
// node 65,536 tokens/attempt, ≤4 attempts; refinement 262,144, ≤8 attempts
// per step; ≤8 refinement iterations. The run-level wall clock (ctx.getDeadline)
// still governs everything, so Terminate / +5 min behave as usual.
//
// Context management: fresh conversation per stage attempt and per node
// (bounded, cache-aligned: the static behavioral prompt is the stable prefix
// xAI's implicit caching keys on); within a conversation, stale tool outputs
// are digested down once they stop being the latest compiler signal, so a
// long compile-fix loop can't quadratically flood its own window. The exit
// is compiler-gated end-to-end: only Leak XIV's certificate of the assembled
// proof counts as success.
// ===========================================================================

const ARCHITECT_MODEL_LADDER = [
  // Verified live against api.x.ai on 2026-07-26: the SKU uses dashes.
  "grok-4-1-fast-reasoning",
  "grok-4-1-fast-non-reasoning",
  "grok-4.1-fast-reasoning",
  "grok-4.1",
  "grok-3-mini",
]
const ARCHITECT_BLUEPRINT_TOKENS = 262144
// The UI's wall clock (default 5 min for this strategy — see
// ARCHITECT_COMPUTE_BUDGET_MS in admin-pipeline.tsx) is now the ONLY governor
// that's meant to actually bind on a normal run; every ceiling below is sized
// so it never truncates a node/blueprint attempt before the deadline does.
const ARCHITECT_NODE_TOKENS = 131072
// MCP tools/call timeouts — match the Python services' own defaults
// (BLUEPRINT_TIMEOUT_S/NODE_TIMEOUT_S/VERIFY_TIMEOUT_S).
const BLUEPRINT_TIMEOUT_MS = 600000
const NODE_TIMEOUT_MS = 300000
const VERIFY_TIMEOUT_MS = 600000
const ARCHITECT_BLUEPRINT_RETRIES = 8
const ARCHITECT_NODE_RETRIES = 6
const ARCHITECT_REFINE_RETRIES = 8
// Default refinement-iteration budget. The UI sends a per-run value (its own
// default is 5, +1 per click) as opts.maxIters, so this is only the fallback
// for callers that don't specify one.
const ARCHITECT_MAX_ITERS = Number(process.env.ARCHITECT_MAX_ITERS || 5)
// Model for the river-delta natural-language proof seed. Runs through the LOCAL
// Claude CLI (one shot, no tools), so its cost is whatever the CLI reports as
// total_cost_usd on its result frame — see architectNlSeed.
const ARCHITECT_SEED_MODEL = process.env.ARCHITECT_SEED_MODEL || "claude-sonnet-5"

// --- Cost accounting ---------------------------------------------------------
// USD per MILLION tokens for the xAI models this pipeline drives. Keyed by
// model-id prefix, longest match first, so a ladder fallback is still priced
// correctly. Verified against xAI's published pricing for the grok-4.1-fast
// SKUs; `c` is the cached-input (prompt-cache read) rate.
//
// The Sonnet seed is NOT priced here: the Claude CLI reports its own
// authoritative `total_cost_usd`, which already accounts for cache reads and
// writes, so using the reported figure is both more accurate and immune to
// price changes (e.g. Sonnet 5's introductory rate ending 2026-08-31).
const GROK_PRICES = [
  ["grok-4.3", { i: 1.25, o: 2.5, c: 0.2 }],
  ["grok-4-3", { i: 1.25, o: 2.5, c: 0.2 }],
  ["grok-4.1-fast", { i: 0.2, o: 0.5, c: 0.05 }],
  ["grok-4-1-fast", { i: 0.2, o: 0.5, c: 0.05 }],
  ["grok-4.1", { i: 0.2, o: 0.5, c: 0.05 }],
  ["grok-3-mini", { i: 0.3, o: 0.5, c: 0.075 }],
]
function grokPrice(model) {
  const m = String(model || "").toLowerCase()
  let best = null
  for (const [prefix, price] of GROK_PRICES) {
    if (m.startsWith(prefix) && (!best || prefix.length > best[0].length)) best = [prefix, price]
  }
  // Unknown SKU: fall back to the fast-tier rate rather than reporting $0, so a
  // new model id can never make a run look free in the research tables.
  return best ? best[1] : { i: 0.2, o: 0.5, c: 0.05 }
}
// Recompute the run's total cost from cumulative token counts + the seed's
// CLI-reported cost. Called after every Grok reply so the live UI figure and the
// cap guard always reflect the same number the research row records.
function architectRecost(ctx, state) {
  // Claude driver (Leak Ultra): the CLI reports authoritative total_cost_usd per
  // stage, already accounting for cache reads/writes — no price table, and the
  // accumulated figure is used as-is. Grok driver: priced from token counts.
  let driver
  if (state.driver === "claude") {
    driver = Number(Number(state.driverCostUsd || 0).toFixed(6))
  } else {
    const p = grokPrice(state.model)
    driver = Number(
      (((state.usage.prompt - state.usage.cached) * p.i +
        state.usage.cached * p.c +
        state.usage.completion * p.o) /
        1e6).toFixed(6),
    )
    state.driverCostUsd = driver
  }
  const seed = Number((state.seedCostUsd || 0).toFixed(6))
  if (!ctx.metrics) return
  ctx.metrics.cost_driver_usd = driver
  ctx.metrics.cost_seed_usd = seed
  ctx.metrics.cost_usd = Number((driver + seed).toFixed(6))
  // Per-bucket token counts exist only for the Grok driver (the xAI response
  // reports them per call). For the Claude driver the CLI reports a combined
  // total, already accumulated into metrics.tokens — leave these unset rather
  // than writing zeros, which would read as "this run used no tokens".
  if (state.driver !== "claude") {
    ctx.metrics.prompt_tokens = state.usage.prompt
    ctx.metrics.completion_tokens = state.usage.completion
    ctx.metrics.cached_tokens = state.usage.cached
  }
  ctx.metrics.models_used = Array.from(state.models)
}
// Higher than the other decomposition paths' defaults: with a short wall
// clock, more parallel node attempts is what actually buys more coverage per
// minute (deadlinePassed() still cuts every stage off the instant time is up).
const ARCHITECT_NODE_CONCURRENCY = Number(process.env.ARCHITECT_NODE_CONCURRENCY || 4)
// HARD dollar ceiling for one architect run — the paper (Appendix A) governs
// by token budgets, never wall clock, and the operator's real fear is an
// unbounded bill, not a long run. Cost is computed live after every Grok call
// (ctx.metrics.cost_usd), so this is enforceable exactly: once crossed, no
// further LLM call is issued anywhere in the pipeline. 0 disables.
const ARCHITECT_MAX_COST_USD = Number(process.env.ARCHITECT_MAX_COST_USD ?? 5)
// Fallback driver model for Leak Ultra when the operator left the dropdown on
// "bridge default". Normally the dropdown value wins — inheriting it is the point.
const ARCHITECT_ULTRA_MODEL = process.env.ARCHITECT_ULTRA_MODEL || "claude-opus-5"
function architectCostCapHit(ctx) {
  return ARCHITECT_MAX_COST_USD > 0 && (ctx?.metrics?.cost_usd || 0) >= ARCHITECT_MAX_COST_USD
}
// Guard used at every stage boundary: true (and emits a one-time notice) when
// the run must stop because the dollar cap is spent.
function architectCapStop(ctx) {
  if (!architectCostCapHit(ctx)) return false
  if (ctx.metrics) ctx.metrics.cost_cap_hit = true
  if (!ctx._costCapNoted) {
    ctx._costCapNoted = true
    ctx.emit?.({
      type: "message-annotation",
      subtype: "error",
      thought: `💸 Architect cost cap reached ($${ARCHITECT_MAX_COST_USD.toFixed(2)}, spend so far $${(ctx.metrics?.cost_usd || 0).toFixed(3)}) — stopping. Raise ARCHITECT_MAX_COST_USD on the bridge to allow deeper runs.`,
    })
  }
  return true
}

// Resolve XI/XII/XIV the SAME way every other Leak server is discovered in
// this app: by NAME, from the servers the operator registered in the
// existing MCP Servers UI (ctx.mcpServers — populated via the app's normal
// /api/mcp/servers -> fetchProverMcpServers path, not a separate mechanism).
// Only the URL matters here; auth type on the registered row is irrelevant.
// Matching is punctuation/case-insensitive so "Leak XI", "Leak-XI",
// "leak_xi" all resolve.
// LEAK_SERVICE_TOKEN deliberately stays a bridge-local env var rather than
// living on the registered-server row: registered-server credentials in this
// app never leave the server side (fetchProverMcpServers strips `credentials`
// down to {name,url} before it ever reaches the browser or this bridge) --
// the bridge needs the RAW bearer token itself to call these services
// directly, so keeping it local matches the existing trust boundary instead
// of poking a hole in it. Same pattern as XAI_API_KEY.
const NORM_NAME = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "")
function findRegisteredUrl(mcpServers, ...aliases) {
  const wanted = aliases.map(NORM_NAME)
  const hit = (mcpServers || []).find((s) => wanted.includes(NORM_NAME(s?.name)))
  return hit?.url || ""
}
function architectUrls(opts = {}, mcpServers = []) {
  const a = opts.architect || {}
  return {
    xi: a.xiUrl || findRegisteredUrl(mcpServers, "Leak XI", "Leak-XI") || process.env.LEAK_XI_URL || "",
    xii: a.xiiUrl || findRegisteredUrl(mcpServers, "Leak XII", "Leak-XII") || process.env.LEAK_XII_URL || "",
    xiv: a.xivUrl || findRegisteredUrl(mcpServers, "Leak XIV", "Leak-XIV") || process.env.LEAK_XIV_URL || "",
  }
}

// --- Appendix C.1 — blueprint generation (behavioral prompt, cached) --------
function architectBlueprintSystem() {
  return `## Task
You are a Lean 4 formalizer producing a dependency graph decomposition for a Lean theorem. The input is the targeted Lean theorem signature. Design a dependency graph of named Definitions, Lemmas, and exactly one Theorem (the main target), then translate the graph into one Lean 4 file in which every node is a \`@[blueprint]\`-annotated declaration. You do not prove anything in this stage -- every theorem and lemma body is \`:= by sorry_using [...]\`.

## Decomposition guidelines
Plan a graph that captures the structure of the proof. Use Definitions for any helper functions, sets, structures, or notation the proof needs. Use Lemmas for intermediate facts that require justification. Use the Theorem for the final claim -- its name MUST equal the targeted theorem identifier given in the user prompt.

Each Lemma should be (nearly) trivial once its parent nodes are taken as given: it should require at most 1-2 new logical ideas beyond its declared dependencies and its own inlined premises. If a step needs more, split it into intermediate lemmas -- use as many components as the proof requires. Independent branches stay independent: if two parts of the proof do not share reasoning, their lemmas should not depend on each other.

Every natural language \`statement\` field is a closed, typed, standalone proposition: every variable carries an explicit quantifier and domain; every hypothesis the proof uses appears as a premise. Do not reach into ambient context -- restate every theorem-level typing and hypothesis your lemma uses. Every natural language \`proof\` field is a complete sketch citing each declared dep by backticked name (e.g. "by \`lemma_a\`", "from \`def_b\`"); show every key equation, and do not write "by algebra", "obviously", or "one can check".

## Mapping graph nodes to Lean declarations
Emit each node of your decomposition directly as a \`@[blueprint ...]\`-annotated Lean declaration. Use \`snake_case\` identifiers derived from content ('k_expansion', 'p_at_101'), not position ('lemma_1'); names must be unique within the file.

- For a Definition, emit:
    @[blueprint (statement := /-- natural language description of what's being defined -/)]
    def name (binders) : type := body
  (or \`noncomputable def\`, \`abbrev\`, \`structure\`, \`instance\` as fits.) Definitions get a real Lean body, not \`sorry_using\`.
- For a Lemma or Theorem, emit:
    @[blueprint
      (statement := /-- closed, typed, standalone natural language proposition -/)
      (proof := /-- complete natural language sketch citing parent declarations by backticked name -/)]
    lemma|theorem name (binders) : conclusion := by sorry_using [p1, p2, ...]
  where \`sorry_using [...]\` lists each parent declaration as a bare Lean identifier (or \`sorry_using []\` if it has no parents).
- The main Theorem's \`name\` MUST equal the targeted theorem identifier given in the user prompt, and you must emit it with the original Lean signature (same binders, same conclusion). Do not retype the statement informally.
- Declare nodes in topological order: Definitions first, then Lemmas in dependency order, then the main Theorem last.
- The file starts with \`import Mathlib\` and \`import Architect\` (both required), then any \`open\`/\`set_option\` lines, then the declarations.

## Tool use
Use \`lean_compile\` to verify the skeleton. Before Lean is invoked, the tool runs structural pre-checks on the raw code; any failure is returned as a \`Safeguard rejected\` response, and the file is never sent to Lean (so do not assume the code compiles). The pre-checks reject: unbalanced \`/- ... -/\` block comments; a missing main theorem; forbidden constructs (\`axiom\`, \`native_decide\`); missing \`import Mathlib\` or \`import Architect\`; a main theorem signature that does not match the targeted signature verbatim (modulo whitespace); a Lemma or Theorem without an \`@[blueprint]\` attribute; a Lemma/Theorem body that is bare \`sorry\` or a real proof -- every body must be exactly \`:= by sorry_using [...]\`, since proofs belong to the next stage and bare \`sorry\` breaks dependency tracking.

If the pre-checks pass, the code is compiled by Lean. After Lean returns no errors, a post-compile graph-validity check runs against the parsed \`@[blueprint]\` decls: every node must have a non-empty \`(statement := /-- ... -/)\` field; every Lemma and the Theorem must have a non-empty \`(proof := /-- ... -/)\` field; every name in \`sorry_using [...]\` must resolve to a declared \`@[blueprint]\` node, with no self-loops; the \`sorry_using\` graph must be acyclic; exactly one main Theorem must exist with the targeted name; and every node must be reachable, in reverse, from the main Theorem (no isolated/dead nodes).

If any gate fails, fix the reported issue and call \`lean_compile\` again. Sorries from \`sorry_using\` are expected and do not count as errors. Iterate until \`lean_compile\` reports \`Compilation SUCCESSFUL. Validation SUCCESSFUL.\``
}

// --- Appendix C.2 — theorem proving (behavioral prompt, cached) -------------
function architectProverSystem() {
  return `## Task
You are a Lean 4 theorem prover. Given a formal statement, produce a complete, correct Lean 4 proof with no \`sorry\`.

## Tool use
You have two tools, \`lean_compile\` and \`mathlib_search\`. Commit to a concrete proof plan up front and execute it against the Lean compiler -- iterating on compiler feedback is how proofs get done, not silent reasoning or repeated searching. The compiler is a stronger signal source than search.

Use \`lean_compile\` to compile Lean 4 code. Call it early, even with a partial proof: use \`sorry\` as a placeholder for sub-goals you cannot yet discharge, and iterate (compile -> read errors / open goals -> patch -> compile). The system handles two cases automatically based on what you submit:
- If your code includes the MAIN theorem with the canonical statement followed by \`:= by ...\`, the system rebuilds it under the original theorem statement: only your \`:= by\` proof body is kept from your submission; the imports, \`set_option\`, and \`open\` lines come from the canonical formal statement, and any other top-level declarations are dropped. Only this case can register a solve. Do not use \`axiom\` or \`native_decide\`; use \`have\` for helper lemmas inside your proof, not top-level declarations; and do not add \`import\` or \`open\` lines that are not already in the canonical formal statement -- any extras will be flagged as a safeguard violation, not silently kept.
- If your code does NOT include the main theorem (e.g. \`#check\`, \`example\`, \`#print\`, helper-lemma prototypes), the system compiles the snippet as-given and returns the raw feedback. This is exploration only -- it cannot register a solve, so resubmit with the main theorem once you have a full proof. Use this sparingly: every turn against the compiler costs budget, and the only way to finish is to submit the main theorem.

Use \`mathlib_search\` as a lookup helper for *specific* Mathlib lemmas you need while executing your plan -- for example a name, signature, or hypothesis pattern like "monotonicity of natural number addition" or "Cauchy-Schwarz inequality", or to recover the correct name after an "Unknown constant" / "Unknown identifier" error. Mathlib does NOT contain the solution to your problem directly, so do not use this tool to "find the proof" or to search for an exact bound stated in the goal -- such queries return nothing useful and waste turns.

## Other outcomes
If you become convinced the statement is FALSE, prove its negation instead: the user prompt gives the exact negated signature to prove. Submit it via \`lean_compile\`; a compiler-corroborated disproof is a valid, registered outcome.`

// The paper's actual Appendix C.2 prompt (verbatim, as published) stops here
// -- it never mentions forfeiting. Telling the model a structured "give up"
// format is available FROM TURN ONE makes it an easy, well-lit exit ramp: a
// fast/cheap model takes it the moment a goal gets algebraically annoying,
// often within a handful of turns and nowhere near its real token budget --
// exactly what happened on this stack's own six_dvd_cubic smoke run. The
// forfeit format is injected instead as a follow-up message, ONLY once a
// node has genuinely exhausted its turn/token budget with no solve -- see
// grokLoop's forced-forfeit turn below. This forces every attempt to spend
// its real budget compiling and iterating before any exit is offered.
}

// --- Appendix C.3 — blueprint refinement (behavioral prompt, cached) --------
function architectRefineSystem() {
  return `## Task
You are revising a Lean 4 dependency graph for a single mathematical problem. The input is a sequence of \`@[blueprint ...]\`-annotated declarations -- definitions, lemmas, and one main theorem -- each lemma or theorem with body \`:= by sorry_using [deps]\`. Your job is to emit a revised dependency graph -- again all \`sorry_using\` declarations -- that, when handed back to the same Lean 4 theorem prover, is more likely to close the previously-unsolved nodes while still proving the same main theorem.

## Input format
Each lemma or theorem in the input carries a one-line marker recording the previous prover pass's verdict on that node, and -- when the prover failed -- a follow-up review block describing what went wrong. There are two markers.

A \`-- PROVED\` marker means the prover proved the node.

A \`-- UNPROVED\` marker indicates that the prover failed on the node, and is followed by exactly one \`/- Diagnosis ... -/\` review block. The block has three sections. \`## Diagnosis\` is exactly one of \`STATEMENT_WRONG\` (the lemma is false under its hypotheses -- possibly established by a machine-checked disproof of the statement) or \`PROOF_TOO_HARD\` (the prover believes the goal is provable but could not chain the available parents to it). \`## Analysis\` is a forensic account of what the prover tried, what compiled, what errors remained, and where the gap is. \`## Suggested Fix\` is conditional on the diagnosis: for \`STATEMENT_WRONG\`, why the statement is false and how to repair it; for \`PROOF_TOO_HARD\`, a helper-lemma decomposition.

These markers and review blocks are input-only -- do NOT copy them into your revised dependency graph.

## Guidance
Each \`-- UNPROVED\` node falls into one of two buckets, decided by the \`## Diagnosis\` label.

When the diagnosis is \`STATEMENT_WRONG\`, the lemma's formal statement is false under its hypotheses. Fix the statement (strengthen hypotheses, weaken the conclusion, fix a quantifier or coercion, etc.) and re-emit it. If the lemma is structurally unfixable, drop it and re-route the nodes that depended on it.

When the diagnosis is \`PROOF_TOO_HARD\`, the prover believes the goal is provable but could not chain the available parents to it. Read the \`## Suggested Fix\` for the prover's proposed helper-lemma decomposition and add new parent lemmas (each as a fresh \`@[blueprint ...]\` declaration with body \`:= by sorry_using [...]\`) that bridge the gap. Wire the failing node's \`sorry_using [...]\` to include the new helpers. If the analysis instead reads as though the statement itself is suspect, treat it as \`STATEMENT_WRONG\` instead -- fix or drop the statement.

Leave \`-- PROVED\` nodes untouched unless a downstream revision forces a signature change: their proof bodies will carry forward automatically as long as the signature stays byte-identical.

After every edit, call \`lean_compile\`. The tool reports pre-compile safeguard violations, real Lean compile errors, the skeleton-out invariant (every theorem/lemma body must remain \`:= by sorry_using [...]\`), graph-validity issues (cycles, missing fields, dead nodes, etc.), and on a clean compile a per-declaration proof-reuse check. Iterate until \`lean_compile\` reports \`Compilation SUCCESSFUL. Validation SUCCESSFUL.\`

## Output
Emit a revised dependency graph. Every theorem and lemma is \`@[blueprint (statement := /-- ... -/) (proof := /-- ... -/)]\`-annotated and ends in \`:= by sorry_using [deps]\`. Definitions are \`@[blueprint (statement := /-- ... -/)]\`-annotated with a real Lean body. Do NOT replace any \`sorry_using\` with an actual proof -- that is the prover's job, not yours. Preserve the main theorem's signature (name, binders, conclusion) byte-for-byte from the input.`
}

// --- Grok driver -------------------------------------------------------------
// One OpenAI-compatible chat call against api.x.ai with function calling,
// retries on 429/5xx, and a model fallback ladder on unknown-model errors.
async function grokCall(state, messages, tools, ctx, callOpts = {}) {
  const key = process.env.XAI_API_KEY
  if (!key) throw new Error("XAI_API_KEY is not set on the bridge — the architect strategy drives Grok directly")
  if (architectCostCapHit(ctx))
    throw new Error(`architect cost cap reached ($${ARCHITECT_MAX_COST_USD.toFixed(2)}) — no further LLM calls this run`)
  for (let attempt = 0; ; attempt++) {
    if (ctx.signal?.aborted) throw new Error("aborted")
    // callOpts.grace: the forced-forfeit turn is the ONE call allowed past the
    // wall-clock deadline — it is what feeds the refinement stage (§4.4), and
    // under a short operator clock most exhaustion IS deadline exhaustion.
    // Bounded: a single no-tools call per attempt, still under the cost cap.
    if (deadlinePassed(ctx) && !callOpts.grace) throw new Error("wall-clock budget exhausted")
    const body = {
      model: state.model,
      messages,
      max_tokens: 8192,
    }
    // xAI rejects tool_choice with an empty tools array outright ("A
    // tool_choice was set on the request but no tools were specified") — this
    // exact 400 was silently killing every forced-forfeit turn, starving the
    // refinement stage of the diagnoses that are its entire input (§4.4 of
    // the paper: forfeits ARE the decomposition proposals). Only attach the
    // tool plumbing when there are tools.
    if (Array.isArray(tools) && tools.length) {
      body.tools = tools
      body.tool_choice = "auto"
    }
    let resp
    try {
      resp = await fetch("https://api.x.ai/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
        body: JSON.stringify(body),
        signal: ctx.signal,
      })
    } catch (e) {
      if (attempt < 4) {
        await new Promise((r) => setTimeout(r, 1500 * 2 ** attempt))
        continue
      }
      throw e
    }
    if (resp.status === 429 || resp.status >= 500) {
      if (attempt < 5) {
        const ra = Number(resp.headers.get("retry-after")) || 2 ** attempt
        ctx.emit?.({ type: "message-annotation", subtype: "status", thought: `⏳ xAI ${resp.status} — retrying in ${Math.min(ra, 30)}s (attempt ${attempt + 1}/5).` })
        await new Promise((r) => setTimeout(r, Math.min(ra, 30) * 1000))
        continue
      }
      throw new Error(`xAI API ${resp.status} after retries`)
    }
    const data = await resp.json().catch(() => null)
    if (!resp.ok) {
      const msg = String(data?.error?.message || data?.error || resp.status)
      // Unknown model → walk the ladder once per rung.
      if (/model/i.test(msg) && (resp.status === 400 || resp.status === 404)) {
        const idx = ARCHITECT_MODEL_LADDER.indexOf(state.model)
        const next = ARCHITECT_MODEL_LADDER[idx + 1]
        if (next) {
          ctx.emit?.({ type: "message-annotation", subtype: "status", thought: `↩︎ Model ${state.model} rejected (${msg}) — falling back to ${next}.` })
          state.model = next
          continue
        }
      }
      throw new Error(`xAI API error: ${msg}`)
    }
    const usage = data.usage || {}
    state.usage.prompt += Number(usage.prompt_tokens) || 0
    state.usage.completion += Number(usage.completion_tokens) || 0
    state.usage.cached += Number(usage.prompt_tokens_details?.cached_tokens) || 0
    state.stageTokens += Number(usage.total_tokens) || 0
    ctx.metrics.llm_invocations += 1
    // Record the SKU that actually served this call (may differ from the one
    // first requested if the ladder fell back) for the row's models_used.
    state.models?.add(state.model)
    // Recompute the whole run's cost — driver tokens priced per SKU, plus any
    // NL-seed cost the CLI reported. Writes `cost_usd` (snake_case) because
    // that's the only key run-prover-stream.ts reads, alongside the per-source
    // split and token counts the research tables record. `state.usage` is
    // cumulative, so this is an assignment, not an accumulation.
    architectRecost(ctx, state)
    return data.choices?.[0]?.message || { content: "" }
  }
}

// Digest stale tool outputs so a long compile-fix loop cannot quadratically
// flood its own context: everything but the newest `keep` tool results is
// collapsed to a one-line summary (the newest compiler signal is the only one
// that matters — the paper's stages are Markov in the latest gate report).
function architectCompact(messages, keep = 2) {
  const toolIdxs = []
  for (let i = 0; i < messages.length; i++) if (messages[i].role === "tool") toolIdxs.push(i)
  const stale = toolIdxs.slice(0, Math.max(0, toolIdxs.length - keep))
  for (const i of stale) {
    const c = String(messages[i].content || "")
    if (c.length > 400)
      messages[i].content = c.slice(0, 300) + `\n... [stale tool output elided — ${c.length} chars; rely on the newest compile report]`
  }
}

// Generic tool loop for one stage attempt: fresh conversation, budgeted,
// short-circuits the moment `exec` reports the stage goal reached.
// Requested ONLY once a grokLoop call has genuinely exhausted its turn/token
// budget with no solve -- matches the paper's actual Appendix C.2 prompt
// (which never mentions forfeiting at all; "user prompts... are omitted").
// Baking this into the turn-1 SYSTEM prompt instead (the original bug here)
// hands a fast/cheap model a well-lit, socially-sanctioned exit ramp from
// turn one -- confirmed live: a real node forfeited in ~150s, nowhere near
// its 65,536-token budget, the moment its Lean goal got algebraically messy.
const ARCHITECT_FORFEIT_REQUEST = `You are out of turns/budget on this goal without a verified proof. This is your FINAL turn -- do not call any tool. Write your forfeit now, in EXACTLY this format (three sections, these exact headers):
## Diagnosis: STATEMENT_WRONG or PROOF_TOO_HARD
## Analysis: a forensic account of what you tried, what compiled, what errors remained, and where the gap is.
## Suggested Fix: for STATEMENT_WRONG, why the statement is false under its hypotheses and how to repair it; for PROOF_TOO_HARD, a helper-lemma decomposition -- named helper lemmas arranged so that each is easy given its parents and the original goal becomes routine given the helpers.`

async function grokLoop(ctx, state, { system, user, tools, exec, tokenBudget, hardTurns = 60, forfeitPrompt, label = "" }) {
  const messages = [
    { role: "system", content: system },
    { role: "user", content: user },
  ]
  state.stageTokens = 0
  let finalText = ""
  const tag = label ? `[${label}] ` : ""

  // Full context this conversation opens with — every dialogue the operator
  // watches gets its own expandable "system" row before any turns happen, so
  // the exact SYSTEM + USER text handed to Grok is always inspectable live.
  ctx.emit({
    type: "system",
    detail: `${tag}Grok context opened (${state.model})\n\n--- SYSTEM ---\n${system}\n\n--- USER ---\n${user}`,
  })

  // Fires ONLY on genuine exhaustion (token budget / deadline / turn cap) —
  // never on a voluntary early stop, and never available to the model until
  // this exact moment. A no-tools call so the reply can only be prose.
  const forceForfeit = async () => {
    if (!forfeitPrompt) return finalText
    messages.push({ role: "user", content: forfeitPrompt })
    ctx.emit({ type: "message-annotation", subtype: "status", thought: `${tag}🏳️ Budget exhausted — requesting a structured forfeit.` })
    try {
      // grace: allowed past the wall-clock deadline (one small no-tools call)
      // so refinement always gets its diagnosis, even on time exhaustion.
      const msg = await grokCall(state, messages, [], ctx, { grace: true })
      const text = String(msg.content || "") || finalText
      if (text.trim()) ctx.emit({ type: "message-annotation", subtype: "status", thought: `${tag}${text}` })
      return text
    } catch (e) {
      ctx.emit({ type: "message-annotation", subtype: "error", thought: `${tag}Forfeit request failed: ${String(e?.message || e)}` })
      return finalText
    }
  }

  // Duplicate-submission guard: hash of every tool call this attempt → its
  // report. Observed live: the prover resubmitting BYTE-IDENTICAL code 8+
  // times, eating the whole budget on a compile loop that can only return the
  // same error. A repeat is answered from cache (no service round-trip) with
  // an explicit "identical input, identical outcome" banner.
  const seen = new Map()
  let nudges = 0

  for (let turn = 0; turn < hardTurns; turn++) {
    if (state.stageTokens >= tokenBudget) return { finalText: await forceForfeit(), exhausted: true }
    if (deadlinePassed(ctx)) return { finalText: await forceForfeit(), exhausted: true }
    if (architectCostCapHit(ctx)) return { finalText, exhausted: true }
    let msg
    try {
      msg = await grokCall(state, messages, tools, ctx)
    } catch (e) {
      ctx.emit({ type: "message-annotation", subtype: "error", thought: `${tag}Grok call failed (turn ${turn + 1}): ${String(e?.message || e)}` })
      throw e
    }
    const toolCalls = msg.tool_calls || []
    messages.push({ role: "assistant", content: msg.content || "", tool_calls: toolCalls.length ? toolCalls : undefined })
    if (msg.content && msg.content.trim())
      ctx.emit({ type: "message-annotation", subtype: "status", thought: `${tag}${msg.content.trim()}` })
    if (!toolCalls.length) {
      finalText = String(msg.content || "")
      // Every registered exit is tool-driven (a lean_compile solve / a
      // validated blueprint) or a structured forfeit. A bare prose reply ends
      // the attempt with NOTHING — observed live as whole blueprint attempts
      // burned on the model pasting a ```lean block as chat instead of
      // calling the tool. Steer it back to the compiler (twice max), per the
      // paper's loop contract ("iterate until lean_compile reports ...").
      if (!/##\s*Diagnosis/i.test(finalText) && nudges < 2) {
        nudges++
        ctx.emit({ type: "message-annotation", subtype: "status", thought: `${tag}↩︎ Reply had no tool call — steering the prover back to lean_compile (nudge ${nudges}/2).` })
        messages.push({
          role: "user",
          content: "Your reply was NOT submitted to the compiler — nothing is checked or registered unless you CALL the lean_compile tool. Never paste Lean code as chat text. Call lean_compile now with your full current candidate.",
        })
        continue
      }
      return { finalText, exhausted: false }
    }
    for (const tc of toolCalls) {
      let args = {}
      try {
        args = JSON.parse(tc.function?.arguments || "{}")
      } catch {}
      ctx.metrics.tools_invoked += 1
      const toolName = tc.function?.name || "tool"
      ctx.emit({
        type: "message-annotation",
        subtype: "tool_intent",
        thought: `${tag}Using ${toolName}`,
        tool: toolName,
        input: JSON.stringify(args, null, 2),
      })
      const sig = `${toolName} ${JSON.stringify(args)}`
      let out
      if (seen.has(sig)) {
        out = {
          report:
            `⚠️ IDENTICAL RESUBMISSION — you already made exactly this ${toolName} call this attempt; identical input can only produce the identical result (repeated below). Change the proof STRUCTURALLY before compiling again — do not rename variables or reorder the same failing tactics.\n\n${seen.get(sig)}`,
        }
      } else {
        try {
          out = await exec(toolName, args)
        } catch (e) {
          out = { report: `tool error: ${String(e?.message || e)}` }
        }
      }
      const outText = String(out.report ?? JSON.stringify(out))
      if (!seen.has(sig)) seen.set(sig, outText.slice(0, 4000))
      ctx.emit({ type: "message-annotation", subtype: "tool_result", thought: `${tag}Tool output`, output: outText.slice(0, 8000) })
      messages.push({ role: "tool", tool_call_id: tc.id, content: outText.slice(0, 24000) })
      if (out.__done) return { finalText: String(msg.content || ""), exhausted: false, done: out.__done }
    }
    architectCompact(messages)
  }
  ctx.emit({ type: "message-annotation", subtype: "status", thought: `${tag}⛔ Hard turn cap (${hardTurns}) reached.` })
  return { finalText: await forceForfeit(), exhausted: true }
}

// ── Claude driver for the architect pipeline (Leak Ultra) ────────────────────
// Same contract as grokLoop — {system, user, tools, exec} in, {finalText, done,
// exhausted} out — so every stage works with either driver and the prompts, gates
// and exit conditions stay identical across the two branches.
//
// The one structural difference: the CLI owns its own tool loop, so instead of us
// dispatching tool calls we SERVE the tools to it from a local MCP server whose
// handlers are these very `exec` closures. Two consequences that matter:
//   * the compile gate and blueprint capture stay bridge-side — a stage can only
//     succeed because `exec` saw lean_compile return ok, never because the model
//     claimed success in prose (the failure mode that wasted whole Grok attempts);
//   * cost is the CLI's own reported total_cost_usd, so Ultra needs no price
//     table and cannot drift when published prices change.
async function claudeArchitectLoop(ctx, state, { system, user, tools, exec, hardTurns = 60, forfeitPrompt, label = "" }) {
  const tag = label ? `[${label}] ` : ""
  ctx.emit({
    type: "system",
    detail: `${tag}Claude context opened (${state.model})\n\n--- SYSTEM ---\n${system}\n\n--- USER ---\n${user}`,
  })

  let done = null
  const handlers = new Map()
  for (const t of tools || []) {
    const fn = t.function || t
    if (!fn?.name) continue
    handlers.set(fn.name, {
      description: fn.description,
      inputSchema: fn.parameters || { type: "object", properties: {} },
      run: async (args) => {
        const out = await exec(fn.name, args || {})
        if (out && out.__done) done = out.__done
        return String(out?.report ?? JSON.stringify(out ?? ""))
      },
    })
  }

  // Cost: read the delta on ctx.metrics.cost_usd, which spawnProverStream sums
  // from each sub-run's result frame. architectRecost then republishes it as the
  // driver share, so the two never double-count.
  const costBefore = Number(ctx.metrics?.cost_usd || 0)
  // The CLI namespaces MCP tools (mcp__architect__lean_compile), while the shared
  // stage contracts name them bare — say so once rather than forking the prompts,
  // which would break the "same prompts as Stone" property this branch rests on.
  const toolNote = `\n\n## Tool names in this session\nThe tools named in these instructions are served over MCP and appear namespaced: \`lean_compile\` is \`mcp__architect__lean_compile\`, \`mathlib_search\` is \`mcp__architect__mathlib_search\`. They are the same tools with the same arguments. Nothing is registered or checked unless you actually CALL the tool — never paste Lean code as chat text.`

  const r = await spawnProverStream(
    {
      prompt: user,
      systemAppend: system + toolNote,
      mcpServers: [],
      bridgeHandlers: handlers,
      model: state.model,
      maxTurns: hardTurns,
      timeoutMs: 0, // the shared wall-clock deadline governs (see getDeadline)
      getDeadline: ctx.getDeadline,
      stage: label ? `[${label}]` : "",
      metrics: ctx.metrics,
      signal: ctx.signal,
      searchBudget: 0,
    },
    {
      // Stop the CLI the moment a stage's gate is satisfied; SIGINT (not kill) so
      // the result frame carrying total_cost_usd still flushes.
      onObject: (o) => {
        if (o?.type === "system" && typeof o.model === "string") state.models?.add(o.model)
        return !!done
      },
      emit: ctx.emit,
    },
  )
  state.models?.add(state.model)
  state.driverCostUsd = Number(state.driverCostUsd || 0) + Math.max(0, Number(ctx.metrics?.cost_usd || 0) - costBefore)
  architectRecost(ctx, state)

  if (done) return { finalText: r.finalText || "", exhausted: false, done }

  // No gate satisfied. Ask once, with no tools, for the structured forfeit the
  // refinement stage reads (the paper's §4.4 decomposition proposal) — otherwise
  // an exhausted node teaches the next blueprint nothing.
  if (forfeitPrompt) {
    ctx.emit({ type: "message-annotation", subtype: "status", thought: `${tag}🏳️ Stage ended without a gate — requesting a structured forfeit.` })
    const fr = await runClaude(
      buildArgs(`${user}\n\n---\n\n${forfeitPrompt}`, {
        model: state.model,
        systemPrompt: system,
        disallowedTools: "Bash Read Write Edit Glob Grep WebFetch WebSearch Task",
        strictMcpConfig: true,
        excludeDynamicSections: true,
      }),
      { cwd: process.cwd(), timeoutMs: 180000 },
    )
    if (typeof fr.costUsd === "number") {
      state.driverCostUsd = Number(state.driverCostUsd || 0) + fr.costUsd
      architectRecost(ctx, state)
    }
    if (fr.ok && fr.text.trim()) {
      ctx.emit({ type: "message-annotation", subtype: "status", thought: `${tag}${fr.text.trim()}` })
      return { finalText: fr.text, exhausted: true }
    }
  }
  return { finalText: r.finalText || "", exhausted: true }
}

// Stage-level driver dispatch: the River family drives Grok over the xAI API,
// Leak Ultra drives the local Claude CLI. Identical opts either way.
const architectLoop = (ctx, state, opts) =>
  state.driver === "claude" ? claudeArchitectLoop(ctx, state, opts) : grokLoop(ctx, state, opts)

const ARCHITECT_COMPILE_TOOL = {
  type: "function",
  function: {
    name: "lean_compile",
    description: "Compile Lean 4 code against the gateway (Mathlib + Architect preloaded). Returns safeguard violations, compiler errors, open goals, and validation results.",
    parameters: {
      type: "object",
      properties: { code: { type: "string", description: "The full Lean 4 code to compile." } },
      required: ["code"],
    },
  },
}
const ARCHITECT_SEARCH_TOOL = {
  type: "function",
  function: {
    name: "mathlib_search",
    description: "Look up specific Mathlib lemmas by name, signature fragment, or hypothesis pattern. Returns name, kind, signature, docstring, module.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string" },
        k: { type: "number", description: "max results (default 12)" },
      },
      required: ["query"],
    },
  },
}

// ---------------------------------------------------------------------------
// Minimal hand-rolled MCP client (SSE transport). XI/XII/XIV are real
// FastMCP servers now (mcp.server.fastmcp, matching every other Leak
// server's wrapper architecture) rather than a bespoke REST API, so the
// app's own "Add Server" UI can register and live-handshake against them
// like any other Leak server. No npm dependency added (the bridge stays a
// zero-install script) -- this IS the whole client: open the SSE stream,
// read the `endpoint` event for where to POST JSON-RPC, do the `initialize`
// handshake, then match tools/call responses back to their request by id.
// One client per server URL, reused for the whole bridge process lifetime
// (concurrent node provers share one session; JSON-RPC ids disambiguate
// concurrent in-flight calls on it).
// ---------------------------------------------------------------------------
class McpSseClient {
  constructor(sseUrl) {
    // Registered MCP servers (findRegisteredUrl, above) store the FULL SSE
    // endpoint — exactly the URL callRemoteMcpTool fetches as-is with no
    // appending, same convention Leak I/II/IV already use. This class used to
    // treat its argument as a bare origin and append "/sse" itself, which
    // turned an already-complete ".../sse" URL into ".../sse/sse" — a path
    // that never existed, 404ing every single connect. `origin` is derived
    // separately (like callRemoteMcpTool's `base`/`origin` split) purely to
    // resolve the server's `endpoint` event, which is relative to the origin,
    // not to the /sse path.
    this.sseUrl = sseUrl.replace(/\/$/, "")
    try {
      const u = new URL(this.sseUrl)
      this.origin = `${u.protocol}//${u.host}`
    } catch {
      this.origin = this.sseUrl
    }
    this.messageUrl = null
    this.nextId = 1
    this.pending = new Map() // id -> {resolve, reject}
    this.readyPromise = null
  }

  async connect() {
    if (!this.readyPromise) {
      // A rejected promise is still truthy, so a failed _connect() (a cold
      // Space, a proxy hiccup mid-boot, anything) would otherwise get cached
      // and replayed FOREVER — every later callTool() would immediately
      // re-throw this same stale error without ever retrying the handshake,
      // even once the Space is confirmed back up. Clear it on rejection so
      // the next call gets a genuinely fresh /sse attempt.
      this.readyPromise = this._connect().catch((e) => {
        this.readyPromise = null
        throw e
      })
    }
    return this.readyPromise
  }

  async _connect() {
    const resp = await fetch(this.sseUrl, { headers: { accept: "text/event-stream" } })
    if (!resp.ok || !resp.body) throw new Error(`MCP SSE connect to ${this.sseUrl} → HTTP ${resp.status}`)
    const endpointReady = new Promise((resolve, reject) => {
      this._resolveEndpoint = resolve
      this._rejectEndpoint = reject
    })
    this._pump(resp.body) // fire-and-forget: feeds endpointReady + this.pending as frames arrive
    const timeout = new Promise((_, rej) =>
      setTimeout(() => rej(new Error(`MCP SSE handshake with ${this.sseUrl} timed out (Space asleep? first request can take 1-2min to wake it)`)), 120000),
    )
    this.messageUrl = await Promise.race([endpointReady, timeout])

    const initId = this.nextId++
    const initResp = await this._rpc({
      jsonrpc: "2.0", id: initId, method: "initialize",
      params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "leak-architect-bridge", version: "1.0" } },
    }, initId, 30000)
    if (initResp.error) throw new Error(`MCP initialize with ${this.sseUrl} failed: ${JSON.stringify(initResp.error)}`)
    await this._notify({ jsonrpc: "2.0", method: "notifications/initialized" })
  }

  async _pump(body) {
    const reader = body.getReader()
    const decoder = new TextDecoder()
    let buf = ""
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        // Servers vary between LF and CRLF frame delimiters (Leak-I's own
        // FastMCP server uses \r\n\r\n) — normalize before splitting so
        // frame detection isn't silently blind to CRLF-terminated streams.
        buf += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n")
        let idx
        while ((idx = buf.indexOf("\n\n")) >= 0) {
          const frame = buf.slice(0, idx)
          buf = buf.slice(idx + 2)
          this._handleFrame(frame)
        }
      }
      throw new Error("MCP SSE stream closed by server")
    } catch (e) {
      if (this._rejectEndpoint) { this._rejectEndpoint(e); this._rejectEndpoint = null }
      for (const { reject } of this.pending.values()) reject(e)
      this.pending.clear()
      this.readyPromise = null // allow a future connect() to retry
    }
  }

  _handleFrame(frame) {
    let event = "message"
    let data = ""
    for (const line of frame.split("\n")) {
      if (line.startsWith("event:")) event = line.slice(6).trim()
      else if (line.startsWith("data:")) data += (data ? "\n" : "") + line.slice(5).trim()
    }
    if (!data) return
    if (event === "endpoint") {
      // Relative to the ORIGIN (matching callRemoteMcpTool's proven pattern),
      // never to this.sseUrl — the server's `endpoint` data is always
      // origin-relative (e.g. "/messages/?session_id=...").
      let url
      try {
        url = new URL(data, this.origin).toString()
      } catch {
        url = this.origin + data
      }
      if (this._resolveEndpoint) { this._resolveEndpoint(url); this._resolveEndpoint = null }
      return
    }
    let obj
    try { obj = JSON.parse(data) } catch { return }
    if (obj.id != null && this.pending.has(obj.id)) {
      const { resolve } = this.pending.get(obj.id)
      this.pending.delete(obj.id)
      resolve(obj)
    }
  }

  async _notify(payload) {
    const resp = await fetch(this.messageUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    })
    if (!resp.ok) throw new Error(`MCP notify POST → HTTP ${resp.status}`)
  }

  async _rpc(payload, id, timeoutMs) {
    const waitPromise = new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }))
    const resp = await fetch(this.messageUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    })
    if (!resp.ok) { this.pending.delete(id); throw new Error(`MCP RPC POST → HTTP ${resp.status}`) }
    const timeout = new Promise((_, rej) =>
      setTimeout(() => { this.pending.delete(id); rej(new Error(`MCP call timed out after ${timeoutMs}ms`)) }, timeoutMs),
    )
    return Promise.race([waitPromise, timeout])
  }

  async callTool(name, args, timeoutMs = 300000) {
    await this.connect()
    const id = this.nextId++
    const rpcResp = await this._rpc(
      { jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } },
      id, timeoutMs,
    )
    if (rpcResp.error) throw new Error(`MCP tool '${name}' error: ${rpcResp.error.message || JSON.stringify(rpcResp.error)}`)
    const content = rpcResp.result?.content || []
    return content.filter((c) => c.type === "text").map((c) => c.text).join("\n")
  }
}

const MCP_CLIENTS = new Map() // baseUrl -> McpSseClient, reused for the process lifetime
function getMcpClient(baseUrl) {
  if (!MCP_CLIENTS.has(baseUrl)) MCP_CLIENTS.set(baseUrl, new McpSseClient(baseUrl))
  return MCP_CLIENTS.get(baseUrl)
}

// lean_compile / verify_full_script return a JSON string as their MCP text
// content (mirroring the {ok, report, graph, ...} shape the old REST version
// returned directly) -- parse it back into an object.
async function architectMcpCall(url, toolName, args, timeoutMs) {
  const text = await getMcpClient(url).callTool(toolName, args, timeoutMs)
  try {
    return JSON.parse(text)
  } catch {
    return { ok: false, report: text }
  }
}

// mathlib_search's tool already returns fully-formatted, citeable text
// server-side (matching Leak-I's own moogle_search/loogle_search pattern) --
// no client-side JSON parsing/formatting needed, just pass it through.
async function architectSearchCall(url, query, k, timeoutMs) {
  const text = await getMcpClient(url).callTool("mathlib_search", { query, k }, timeoutMs)
  return { report: text }
}

// Prelude = open/set_option lines between the imports and the first decl.
function architectPrelude(code) {
  const lines = []
  for (const ln of String(code || "").split("\n")) {
    const t = ln.trim()
    if (/^import\s/.test(t) || t === "") continue
    if (/^(open|set_option|noncomputable section|section)\b/.test(t)) {
      lines.push(t)
      continue
    }
    break
  }
  return lines.join("\n")
}

// Compile context for one node: every earlier node in topological order —
// defs with real bodies (attribute stripped), lemmas/theorems sorried. The
// PROMPT context stays exactly the declared parents; this larger closure is
// compiler-only and costs the model nothing.
function architectNodePrefix(graph, nodeName) {
  const idx = graph.findIndex((n) => n.name === nodeName)
  const before = graph.slice(0, Math.max(0, idx))
  return before
    .map((n) =>
      n.kind === "def" || n.kind === "abbrev" || n.kind === "structure" || n.kind === "instance" || n.kind === "inductive"
        ? n.declTextNoAttr
        : `${n.signature.trim()} := by sorry`,
    )
    .join("\n\n")
}

function architectNegSignature(signature) {
  const m = signature.match(/^\s*(?:theorem|lemma)\s+([A-Za-z_][A-Za-z0-9_'.]*)/)
  if (!m) return null
  const rest = signature.slice(m[0].length)
  let depth = 0
  for (let i = 0; i < rest.length; i++) {
    const c = rest[i]
    if ("([{⟨".includes(c)) depth++
    else if (")]}⟩".includes(c)) depth--
    else if (c === ":" && depth === 0 && rest.slice(i, i + 2) !== ":=") {
      const binders = rest.slice(0, i).trim()
      const concl = rest.slice(i + 1).trim()
      const inner = binders ? `∀ ${binders}, ${concl}` : concl
      return `theorem ${m[1]}_neg : ¬ (${inner})`
    }
  }
  return null
}

// --- Dead-end ledger (river-gate / river-delta) ------------------------------
// The paper isolates node provers deliberately: each gets a fresh context with
// only its declared parents, so parallel attempts can't correlate. That is right
// for proof STRATEGY, but it also means every node independently rediscovers the
// same environment facts. Observed live on mirage_break: three sibling nodes each
// burned turns learning that `partial_sum_mono` doesn't exist, and separately
// that `1 / list.getD i 1` elaborates over ℕ without a `(1:ℚ)` ascription.
//
// The ledger shares ONLY environment facts — names that don't resolve, typeclass
// instances that aren't available, elaboration/coercion traps. It never shares a
// tactic that worked, a proof body, or any node's approach, so node independence
// (and the paper's parallel-attempt semantics) is preserved.
//
// Bounded by construction: deduped by key, capped at LEDGER_MAX entries, each
// entry one short line. Run-scoped rather than iteration-scoped because "this
// name is not in Mathlib" stays true across refinements.
const LEDGER_MAX = 40
function makeDeadEndLedger() {
  return { entries: new Map(), shared: 0 }
}
// Pull environment-level dead ends out of one compiler report.
function ledgerHarvest(ledger, report, nodeName) {
  if (!ledger || !report) return
  const text = String(report)
  const add = (key, note) => {
    if (ledger.entries.size >= LEDGER_MAX || ledger.entries.has(key)) return
    ledger.entries.set(key, { note, from: nodeName })
  }
  // Names the environment does not contain — highest-signal, zero strategy leak.
  for (const m of text.matchAll(/Unknown (?:identifier|constant)\s+`([^`]+)`/g))
    add(`name:${m[1]}`, `\`${m[1]}\` does not exist — do not use it (or any close guess at it).`)
  // Typeclass instances that aren't derivable for the types in play.
  for (const m of text.matchAll(/failed to synthesize(?:\s+instance of type class)?\s*\n?\s*([A-Za-z_][\w'.]*(?:\s+[^\n]{0,60})?)/g))
    add(`inst:${m[1].trim()}`, `typeclass \`${m[1].trim()}\` is not available here — avoid lemmas that require it.`)
  for (const m of text.matchAll(/typeclass instance problem is stuck\s*\n?\s*([A-Za-z_][\w'.]*)/g))
    add(`stuck:${m[1]}`, `typeclass \`${m[1]}\` gets stuck (needs its type pinned by an explicit ascription).`)
  // Elaboration / coercion traps: record the mismatched pair compactly. This is
  // the class of failure that cost the most turns in practice (e.g. `1 / xs.getD
  // i 1` silently elaborating over ℕ instead of ℚ).
  //
  // Mismatches containing metavariables (`?m.57`, `?a`) are SKIPPED: they are
  // artefacts of a unification that never completed, not stable facts about the
  // environment, and they read as noise in a sibling's prompt. Verified against a
  // real mirage_break run — 3 of 12 harvested mismatches were metavariable-only
  // and carried no actionable information, while the named-identifier and
  // typeclass facts were all genuinely load-bearing.
  for (const m of text.matchAll(/has type\s*\n?\s*\(?([^\n]{1,90}?)\)?\s*\n?\s*but is expected to have type\s*\n?\s*\(?([^\n]{1,90}?)\)?\s*\n/g)) {
    const got = m[1].trim()
    const want = m[2].trim()
    if (!got || !want || got === want) continue
    if (/\?\w/.test(got) || /\?\w/.test(want)) continue
    add(`coe:${got}=>${want}`, `type mismatch seen: \`${got}\` where \`${want}\` was expected — ascribe the numeral/type explicitly.`)
  }
}
// Render the ledger for a node's prompt. `excludeNode` drops facts the node
// found itself (its own context already has those errors verbatim).
function ledgerRender(ledger, excludeNode) {
  if (!ledger || ledger.entries.size === 0) return ""
  const lines = []
  for (const [, v] of ledger.entries) {
    if (v.from && v.from === excludeNode) continue
    lines.push(`- ${v.note}`)
  }
  if (!lines.length) return ""
  ledger.shared += lines.length
  return `\n\n## Known dead ends (established by the compiler on sibling nodes of this same problem — treat as facts, not suggestions)\n${lines.join("\n")}\n\nThese are environment facts only; no proof strategy is implied. Do not spend turns rediscovering them.`
}

function architectParseForfeit(text) {
  const diag = /##\s*Diagnosis:?\s*(STATEMENT_WRONG|PROOF_TOO_HARD)/i.exec(text || "")
  const analysis = /##\s*Analysis:?\s*([\s\S]*?)(?=##\s*Suggested Fix|$)/i.exec(text || "")
  const fix = /##\s*Suggested Fix:?\s*([\s\S]*)$/i.exec(text || "")
  return {
    diagnosis: diag ? diag[1].toUpperCase() : "PROOF_TOO_HARD",
    analysis: (analysis?.[1] || "The prover returned no structured analysis; it ran out of budget.").trim().slice(0, 2500),
    fix: (fix?.[1] || "No suggested fix was produced.").trim().slice(0, 2500),
  }
}

// The annotated graph the refinement stage consumes: decl + verdict marker
// (+ Diagnosis block for failures). Compact signals, never transcripts.
function architectAnnotate(graph, results) {
  return graph
    .map((n) => {
      if (!["lemma", "theorem"].includes(n.kind)) return n.declText
      const r = results.get(n.name)
      if (r?.solved) return `${n.declText}\n-- PROVED`
      const f = r?.forfeit || { diagnosis: "PROOF_TOO_HARD", analysis: "Node was not attempted (an upstream failure consumed the budget).", fix: "" }
      const diag = r?.negated ? "STATEMENT_WRONG" : f.diagnosis
      const analysis = r?.negated
        ? `MACHINE-CHECKED DISPROOF: the prover formally proved the NEGATION of this statement. ${f.analysis}`
        : f.analysis
      return `${n.declText}\n-- UNPROVED\n/- Diagnosis\n## Diagnosis: ${diag}\n## Analysis: ${analysis}\n## Suggested Fix: ${f.fix}\n-/`
    })
    .join("\n\n")
}

function architectAssemble(graph, prelude, proofs) {
  const parts = ["import Mathlib", ""]
  if (prelude) parts.push(prelude, "")
  for (const n of graph) {
    if (["lemma", "theorem"].includes(n.kind)) {
      const body = proofs.get(n.name)
      const indented = String(body || "").split("\n").map((l) => (l.trim() ? "  " + l : l)).join("\n")
      parts.push(`${n.signature.trim()} :=\n${indented}`, "")
    } else {
      parts.push(n.declTextNoAttr, "")
    }
  }
  return parts.join("\n")
}

// --- Node prover (fresh, isolated conversation per attempt) -----------------
async function architectProveNode(node, graph, prelude, urls, ctx, state) {
  const parents = node.deps
    .map((d) => graph.find((g) => g.name === d))
    .filter(Boolean)
    .map((p) => {
      // Present a clean `name : type` fact line. The raw signature keeps its
      // modifiers + keyword + name (e.g. "noncomputable def partial_sum (n :
      // ℕ) : ℚ"), which the old strip missed for modifier-prefixed decls and
      // double-rendered for lemmas ("sum_13_eq_one : : partial_sum 13 = 1").
      const sig = p.signature
        .replace(/^\s*(?:noncomputable\s+|private\s+|protected\s+)*(?:theorem|lemma|def|abbrev|structure|instance|inductive)\s+[A-Za-z0-9_'.]+\s*/, "")
        .replace(/^:\s*/, "")
        .trim()
      return `- ${p.kind} ${p.name} : ${sig}${p.statement ? `\n    (${String(p.statement).slice(0, 240)})` : ""}`
    })
    .join("\n")
  const negSig = architectNegSignature(node.signature)
  const prefix = architectNodePrefix(graph, node.name)
  const user = `## Target
Prove this EXACT statement (the signature is immutable — your submission is rebuilt under it):

${node.signature.trim()} := by
  <your proof>

## Blueprint context
Natural-language statement: ${node.statement || "(none)"}
Proof sketch from the blueprint: ${node.proofSketch || "(none)"}

## Available facts (your declared dependencies — already proved or defined; invoke by name)
${parents || "(none — this node has no parents)"}
${negSig ? `\n## Disproof option\nIf you verify the statement is FALSE under its hypotheses, prove instead exactly:\n\n${negSig} := by\n  <your disproof>\n` : ""}`

  const result = { solved: false, negated: false, proofBody: null, forfeit: null, attempts: 0 }
  // The last compiler feedback of the previous fresh attempt. Fed into the
  // next attempt's retry note so "fresh" never means "amnesiac": observed
  // live, a node repeated the exact same broken tactic skeleton across every
  // fresh attempt because nothing carried the wall it kept hitting.
  let lastError = ""
  for (let attempt = 0; attempt < ARCHITECT_NODE_RETRIES; attempt++) {
    if (deadlinePassed(ctx) || ctx.signal?.aborted || architectCapStop(ctx)) break
    result.attempts = attempt + 1
    // Rendered per attempt (not once per node) so a node starting late in the
    // pass — or retrying — sees everything its siblings have learned by then.
    const deadEnds = ledgerRender(state.ledger, node.name)
    const retryNote =
      attempt === 0
        ? ""
        : `\n\n(Attempt ${attempt + 1} of ${ARCHITECT_NODE_RETRIES}. A previous fresh attempt failed.${
            lastError ? ` Its final compiler feedback was:\n${lastError}\nThat approach hit a wall — take a structurally different route.` : " Do not repeat the same failing tactic line verbatim."
          })`
    const exec = async (name, args) => {
      if (name === "mathlib_search") {
        if (!urls.xi) return { report: "mathlib_search is unavailable (Leak XI not configured); reason from Mathlib knowledge and compiler feedback." }
        return architectSearchCall(urls.xi, String(args.query || ""), Number(args.k) || 12, 60000)
      }
      if (name === "lean_compile") {
        const r = await architectMcpCall(urls.xii, "lean_compile", {
          mode: "node",
          code: String(args.code || ""),
          target_name: node.name,
          target_signature: node.signature,
          target_neg_signature: negSig || "",
          prefix,
          prelude,
        }, Number(NODE_TIMEOUT_MS))
        if (r.solve) {
          // Extract the rebuilt body (everything after the first ':=').
          const rebuilt = String(r.rebuilt || "")
          const at = rebuilt.indexOf(":=")
          return { report: r.report, __done: { negated: !!r.negated, body: rebuilt.slice(at + 2).trim() } }
        }
        lastError = String(r.report || "").slice(0, 900)
        // Pool environment-level facts for sibling nodes (gate/delta only —
        // state.ledger is null for the control).
        ledgerHarvest(state.ledger, r.report, node.name)
        return { report: r.report }
      }
      return { report: `unknown tool ${name}` }
    }
    const out = await architectLoop(ctx, state, {
      system: architectProverSystem(),
      user: user + deadEnds + retryNote,
      tools: [ARCHITECT_COMPILE_TOOL, ARCHITECT_SEARCH_TOOL],
      exec,
      tokenBudget: ARCHITECT_NODE_TOKENS,
      forfeitPrompt: ARCHITECT_FORFEIT_REQUEST,
      label: `node ⟪${node.name}⟫ · attempt ${attempt + 1}/${ARCHITECT_NODE_RETRIES}`,
    })
    if (out.done) {
      result.solved = !out.done.negated
      result.negated = !!out.done.negated
      result.proofBody = out.done.body
      return result
    }
    // No solve this attempt: keep the best structured forfeit we saw.
    if (out.finalText && /##\s*Diagnosis/i.test(out.finalText)) {
      result.forfeit = architectParseForfeit(out.finalText)
      break // an explicit forfeit is terminal for this pass — refinement owns it now
    }
  }
  if (!result.solved && !result.negated && !result.forfeit)
    result.forfeit = architectParseForfeit("")
  return result
}

// --- Blueprint / refinement conversation (shared shape) ----------------------
async function architectBlueprintStage(ctx, state, urls, { system, user, retries, stageLabel = "blueprint" }) {
  let lastReport = ""
  for (let attempt = 0; attempt < retries; attempt++) {
    if (deadlinePassed(ctx) || ctx.signal?.aborted || architectCapStop(ctx)) return null
    let captured = null
    const exec = async (name, args) => {
      if (name === "mathlib_search") {
        if (!urls.xi) return { report: "mathlib_search is unavailable; proceed from Mathlib knowledge." }
        return architectSearchCall(urls.xi, String(args.query || ""), Number(args.k) || 12, 60000)
      }
      if (name === "lean_compile") {
        const r = await architectMcpCall(urls.xii, "lean_compile", {
          mode: "blueprint",
          code: String(args.code || ""),
          target_name: state.targetName,
          target_signature: state.targetSignature,
        }, Number(BLUEPRINT_TIMEOUT_MS))
        lastReport = String(r.report || "").slice(0, 1200)
        if (r.ok) {
          captured = { graph: r.graph, code: String(args.code || "") }
          return { report: r.report, __done: captured }
        }
        return { report: r.report }
      }
      return { report: `unknown tool ${name}` }
    }
    const retryNote = attempt === 0 ? "" : `\n\n(Attempt ${attempt + 1} of ${retries}. The previous attempt failed its last gate with:\n${lastReport}\nStart fresh and fix that.)`
    const out = await architectLoop(ctx, state, {
      system,
      user: user + retryNote,
      tools: [ARCHITECT_COMPILE_TOOL, ARCHITECT_SEARCH_TOOL],
      exec,
      tokenBudget: ARCHITECT_BLUEPRINT_TOKENS,
      label: `${stageLabel} · attempt ${attempt + 1}/${retries}`,
    })
    if (out.done) return out.done
  }
  return null
}

// --- Natural-language proof seed (river-delta) --------------------------------
// One shot, before blueprint generation: ask the LOCAL Claude CLI (Sonnet 5) for
// an informal proof of the target, and hand it to the blueprint stage as a
// structural guide (the paper's §4.2 NL guidance, where a separate model writes
// the informal argument and the pipeline derives the lemma graph from it).
//
// Deliberately NOT reused for refinement: refinement's input is the annotated
// graph plus machine-checked per-node diagnoses, and the paper only ever seeds
// the INITIAL blueprint. Feeding a static informal proof back in would compete
// with concrete compiler evidence about what actually failed.
//
// Cost: the CLI's own reported total_cost_usd, added to the run's total.
async function architectNlSeed(theorem, ctx, state) {
  const system =
    "You are a research mathematician. Given a Lean 4 theorem signature, write the natural-language proof of the mathematical statement it expresses. Plain mathematical prose only — no Lean code, no tactics, no Mathlib lemma names. State every intermediate claim you rely on explicitly, as a numbered chain of steps a formaliser could turn one-for-one into named lemmas. If you believe the statement is FALSE, say so plainly and give the counterexample. Be complete but do not pad."
  const prompt = `Write the natural-language proof of this Lean 4 theorem's mathematical content:\n\n${state.targetSignature}\n\nAnswer with the proof only.`
  ctx.emit({
    type: "message-annotation",
    subtype: "status",
    thought: `🌱 NL seed [${ARCHITECT_SEED_MODEL}, local]: writing an informal proof to guide blueprint generation.`,
  })
  let r
  try {
    r = await runClaude(
      buildArgs(prompt, {
        model: ARCHITECT_SEED_MODEL,
        systemPrompt: system,
        // Pure reasoning task: no tools, no MCP, no dynamic sections — keeps the
        // call cheap and makes its cost attributable to the seed alone.
        disallowedTools: "Bash Read Write Edit Glob Grep WebFetch WebSearch Task",
        strictMcpConfig: true,
        excludeDynamicSections: true,
      }),
      { cwd: undefined, timeoutMs: Number(BLUEPRINT_TIMEOUT_MS) },
    )
  } catch (e) {
    ctx.emit({ type: "message-annotation", subtype: "error", thought: `⚠️ NL seed failed (${String(e?.message || e)}) — continuing without it.` })
    return ""
  }
  if (typeof r?.costUsd === "number") {
    state.seedCostUsd = (state.seedCostUsd || 0) + r.costUsd
    state.models.add(ARCHITECT_SEED_MODEL)
    architectRecost(ctx, state)
  }
  const text = String(r?.text || "").trim()
  if (!r?.ok || !text) {
    ctx.emit({ type: "message-annotation", subtype: "error", thought: `⚠️ NL seed produced nothing usable — continuing without it.` })
    return ""
  }
  ctx.emit({
    type: "system",
    detail: `[NL seed · ${ARCHITECT_SEED_MODEL} · $${(r.costUsd || 0).toFixed(4)}]\n\n${text}`,
  })
  return text
}

// --- The pipeline -------------------------------------------------------------
async function proveArchitect(theorem, ctx, opts = {}) {
  const urls = architectUrls(opts, ctx.mcpServers)
  if (!urls.xii || !urls.xiv) {
    ctx.emit({ type: "error", message: "Architect needs LEAK_XII_URL and LEAK_XIV_URL set on the bridge (Leak XI optional for search). Set the env vars and restart the bridge." })
    return { verified: false, proof: "" }
  }
  const variant = architectConfigFor(ctx.strategy)
  // Refinement budget for THIS run, read LIVE off the run state (the UI's
  // "+1 iter" button raises it via /extend, exactly like "+5 min" raises the
  // deadline) so a bump lands even while the final iteration is running. Falls
  // back to opts for callers with no run registry (e.g. direct invocation).
  const maxIters = () =>
    (typeof ctx.getMaxIters === "function" ? ctx.getMaxIters() : 0) ||
    clampNum(opts.maxIters, 1, 32, ARCHITECT_MAX_ITERS)
  const driver = architectDriverFor(ctx.strategy)
  const state = {
    driver,
    // Grok driver: force a grok SKU (the River family locks the selector to one).
    // Claude driver: honour the operator's dropdown choice verbatim — that is the
    // whole point of Leak Ultra, so no ladder and no substitution here.
    model:
      driver === "claude"
        ? String(ctx.model || "").trim() || ARCHITECT_ULTRA_MODEL
        : /grok/i.test(String(ctx.model || ""))
          ? String(ctx.model)
          : process.env.ARCHITECT_MODEL || ARCHITECT_MODEL_LADDER[0],
    usage: { prompt: 0, completion: 0, cached: 0 },
    stageTokens: 0,
    // Cost accounting: driver (Grok, from token counts) + seed (Sonnet, from the
    // CLI's reported total_cost_usd). `models` records every model that actually
    // ran, including ladder fallbacks, for the research row's models_used.
    seedCostUsd: 0,
    driverCostUsd: 0,
    models: new Set(),
    // Shared environment facts across node provers — gate/delta only. Null for
    // the control, so its nodes stay exactly as isolated as the paper's.
    ledger: variant.shareDeadEnds ? makeDeadEndLedger() : null,
    targetName: (theorem.match(/(?:theorem|lemma)\s+([A-Za-z_][A-Za-z0-9_'.]*)/) || [])[1] || "target",
    targetSignature: theorem.replace(/:=\s*by[\s\S]*$/, "").replace(/:=\s*sorry[\s\S]*$/, "").trim(),
  }
  if (ctx.metrics) {
    ctx.metrics.max_iters = maxIters()
    ctx.metrics.models_used = []
    ctx.metrics.driver = driver
  }
  ctx.emit({
    type: "message-annotation",
    subtype: "status",
    thought: `🏛️ ${pickStrategy(ctx.strategy).label}\n   driver=${driver === "claude" ? "claude CLI" : "grok API"}:${state.model} · refinement budget=${maxIters()} (raise it live with "+1 iter") · dead-end ledger=${variant.shareDeadEnds ? "on" : "off"} · NL seed=${variant.nlSeedLocal ? ARCHITECT_SEED_MODEL : "off"}\n   toolchain=${TOOLCHAINS.architect.lean} · Mathlib ${TOOLCHAINS.architect.mathlib} (${TOOLCHAINS.architect.group})`,
  })

  // NL guidance is a VARIANT property, not a caller option. Honouring a supplied
  // nlProof on stone/gate would silently hand the "control" a natural-language
  // solution the paper's pipeline never sees — which is exactly what the ACG
  // pipeline was doing, making Stone not a control and leaving Delta's local seed
  // dead code (nlText was always pre-filled, so architectNlSeed never ran).
  // Variants without nlSeedLocal now ignore opts.nlProof outright, so no caller
  // can contaminate the control by accident.
  let nlText = ""
  if (variant.nlSeedLocal) {
    nlText = typeof opts.nlProof === "string" && opts.nlProof.trim() ? opts.nlProof.trim() : ""
    // river-delta's defining intervention: when no informal proof was handed in,
    // generate one locally with Sonnet from the SIGNATURE ALONE.
    if (!nlText) nlText = await architectNlSeed(theorem, ctx, state)
  } else if (typeof opts.nlProof === "string" && opts.nlProof.trim()) {
    ctx.emit({
      type: "message-annotation",
      subtype: "status",
      thought: `🚫 Ignoring the caller's natural-language proof — ${pickStrategy(ctx.strategy).label.split("—")[0].trim()} runs without NL guidance by design.`,
    })
  }
  const nlSeed = nlText
    ? `\n\n## Natural-language proof (structural guide — derive the lemma graph from it)\n${nlText.slice(0, 8000)}`
    : ""
  if (ctx.metrics) ctx.metrics.nl_seed_used = !!nlSeed
  const bpUser = `Targeted Lean theorem (the main Theorem node MUST carry this exact name and signature):\n\n${state.targetSignature}${nlSeed}`

  let bp = await architectBlueprintStage(ctx, state, urls, {
    system: architectBlueprintSystem(),
    user: bpUser,
    retries: ARCHITECT_BLUEPRINT_RETRIES,
    stageLabel: "blueprint generation",
  })
  if (!bp) {
    ctx.emit({ type: "message-annotation", subtype: "error", thought: "❌ Architect: no compiling blueprint within the retry budget." })
    return { verified: false, proof: "" }
  }

  const proofs = new Map() // name -> proof body ("by ...") for solved nodes
  const sigOfProof = new Map() // name -> signatureNorm at solve time

  // Unbounded loop with a LIVE cap check at the bottom — the budget can grow
  // mid-iteration, so it can't be baked into the loop condition.
  for (let iter = 0; ; iter++) {
    const graph = bp.graph
    const prelude = architectPrelude(bp.code)
    const provable = graph.filter((n) => ["lemma", "theorem"].includes(n.kind))
    // Proof reuse: byte-identical (whitespace-normalised) signatures keep their proofs.
    for (const n of provable) {
      if (proofs.has(n.name) && sigOfProof.get(n.name) !== n.signatureNorm) {
        proofs.delete(n.name)
        sigOfProof.delete(n.name)
      }
    }
    const todo = provable.filter((n) => !proofs.has(n.name))
    ctx.emit({ type: "message-annotation", subtype: "status", thought: `📐 Blueprint iteration ${iter}: ${graph.length} nodes (${provable.length} provable, ${todo.length} open, ${proofs.size} carried forward).` })

    // ---- Theorem proving: isolated node conversations, capped parallel pool.
    const results = new Map()
    let cursor = 0
    const workers = Array.from({ length: Math.max(1, Math.min(ARCHITECT_NODE_CONCURRENCY, todo.length)) }, async () => {
      while (cursor < todo.length) {
        const node = todo[cursor++]
        if (deadlinePassed(ctx) || ctx.signal?.aborted || architectCapStop(ctx)) return
        ctx.emit({ type: "message-annotation", subtype: "status", thought: `⛏️ node ⟪${node.name}⟫ — fresh isolated prover (${node.deps.length} parent(s)).` })
        const r = await architectProveNode(node, graph, prelude, urls, ctx, state)
        results.set(node.name, r)
        if (r.solved) {
          proofs.set(node.name, r.proofBody)
          sigOfProof.set(node.name, node.signatureNorm)
          ctx.emit({ type: "message-annotation", subtype: "status", thought: `✅ node ⟪${node.name}⟫ solved (attempt ${r.attempts}).` })
        } else if (r.negated) {
          ctx.emit({ type: "message-annotation", subtype: "status", thought: `🧨 node ⟪${node.name}⟫ DISPROVED — machine-checked negation registered (STATEMENT_WRONG).` })
        } else {
          ctx.emit({ type: "message-annotation", subtype: "status", thought: `🏳️ node ⟪${node.name}⟫ forfeited: ${r.forfeit?.diagnosis}.` })
        }
      }
    })
    await Promise.all(workers)

    // Research telemetry (Leak River table): snapshot after every pass so the
    // FINAL values — whatever they are when this function returns, success or
    // not — reflect the state at that point. Same `ctx.metrics` object every
    // SSE frame carries, so this reaches the client's terminal `done` frame for free.
    ctx.metrics.blueprint_iterations = iter + 1
    ctx.metrics.max_iters = maxIters()
    ctx.metrics.nodes_total = provable.length
    // Count solves WITHIN the current graph. `proofs` is keyed by node name and
    // deliberately carries entries across refinements (proof reuse), including
    // nodes a later blueprint dropped — so proofs.size could exceed the node
    // count and print nonsense like "nodes 9/4".
    ctx.metrics.nodes_solved = provable.filter((n) => proofs.has(n.name)).length
    ctx.metrics.nodes_negated = Array.from(results.values()).filter((r) => r.negated).length
    ctx.metrics.nodes_forfeited = Array.from(results.values()).filter((r) => !r.solved && !r.negated).length
    // Gate/delta only: how many dead-end facts were injected into node prompts,
    // and how many distinct ones the run learned. Both 0/absent for the control.
    if (state.ledger) {
      ctx.metrics.dead_ends_shared = state.ledger.shared
      ctx.metrics.dead_ends_known = state.ledger.entries.size
    }

    const unsolved = provable.filter((n) => !proofs.has(n.name))
    if (unsolved.length === 0) {
      // ---- Assembly + certification (Leak XIV is the only exit).
      ctx.emit({ type: "message-annotation", subtype: "status", thought: "🧵 All nodes solved — assembling the final proof for Leak XIV certification." })
      const finalCode = architectAssemble(graph, prelude, proofs)
      let cert
      try {
        cert = await architectMcpCall(urls.xiv, "verify_full_script", {
          code: finalCode,
          target_name: state.targetName,
          target_signature: state.targetSignature,
        }, Number(VERIFY_TIMEOUT_MS))
      } catch (e) {
        cert = { ok: false, report: String(e?.message || e) }
      }
      if (cert.ok) {
        ctx.emit({ type: "message-annotation", subtype: "status", thought: "🏁 Leak XIV certified the assembled proof — no errors, no sorry." })
        return { verified: true, proof: finalCode }
      }
      // Assembly failed: demote every node named in the error report and refine.
      ctx.emit({ type: "message-annotation", subtype: "error", thought: `⚠️ Assembly failed certification — demoting implicated nodes and refining. ${String(cert.report || "").slice(0, 300)}` })
      const errText = String(cert.report || "")
      let demoted = 0
      for (const n of provable) {
        if (errText.includes(n.name) && proofs.has(n.name)) {
          proofs.delete(n.name)
          sigOfProof.delete(n.name)
          results.set(n.name, { solved: false, negated: false, forfeit: { diagnosis: "PROOF_TOO_HARD", analysis: `The node's proof passed in isolation but failed during final assembly: ${errText.slice(0, 800)}`, fix: "Adjust this node (or its parents) so the proof also elaborates in the assembled file." } })
          demoted++
        }
      }
      if (!demoted) {
        // Nothing attributable — demote the main theorem as the safest restart point.
        proofs.delete(state.targetName)
        sigOfProof.delete(state.targetName)
        results.set(state.targetName, { solved: false, negated: false, forfeit: { diagnosis: "PROOF_TOO_HARD", analysis: `Final assembly failed: ${errText.slice(0, 800)}`, fix: "Re-derive the main theorem's closing argument." } })
      }
    }

    if (iter >= maxIters()) break
    if (deadlinePassed(ctx) || ctx.signal?.aborted || architectCapStop(ctx)) break

    // ---- Blueprint refinement on the annotated graph.
    const stillUnsolved = provable.filter((n) => !proofs.has(n.name))
    ctx.emit({ type: "message-annotation", subtype: "status", thought: `🔁 Refinement ${iter + 1}/${maxIters()}: ${stillUnsolved.length} unsolved node(s) — rewriting the graph around the failures.` })
    const solvedMarks = new Map(provable.map((n) => [n.name, { solved: proofs.has(n.name), ...(results.get(n.name) || {}) }]))
    const annotated = `import Mathlib\nimport Architect\n\n${prelude ? prelude + "\n\n" : ""}${architectAnnotate(graph, solvedMarks)}`
    const refined = await architectBlueprintStage(ctx, state, urls, {
      system: architectRefineSystem(),
      user: `Targeted Lean theorem (preserve this signature byte-for-byte):\n\n${state.targetSignature}\n\n## Current dependency graph with per-node verdicts\n\n${annotated}`,
      retries: ARCHITECT_REFINE_RETRIES,
      stageLabel: `refinement ${iter + 1}/${maxIters()}`,
    })
    if (!refined) {
      ctx.emit({ type: "message-annotation", subtype: "error", thought: "❌ Refinement failed to produce a validated revised blueprint." })
      break
    }
    bp = refined
  }

  ctx.emit({ type: "message-annotation", subtype: "error", thought: "❌ Architect: iteration budget exhausted without a certified proof." })
  return { verified: false, proof: "" }
}


// SSE entrypoint for the decomposition orchestrator. Emits the SAME frame shapes
// as proveStream (prompt / message-annotation / thinking / text-delta / done),
// so the existing client + ProverConsole render it with no changes.
function proveTreeStream(res, theorem, mcpServers, opts = {}) {
  theorem = normalizeProblemSyntax(theorem)
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache, no-transform" })
  const send = (obj) => {
    try {
      res.write(`data: ${JSON.stringify(obj)}\n\n`)
    } catch {
      /* client gone */
    }
  }
  const start = Date.now()
  const metrics = { tools_invoked: 0, llm_invocations: 0, time_elapsed: 0, bridge_build: BRIDGE_BUILD }
  const emit = (obj) => {
    metrics.time_elapsed = Math.round((Date.now() - start) / 1000)
    send({ ...obj, metrics })
  }

  const strategy = STRATEGIES[opts.strategy] ? opts.strategy : "hacker"
  const style = styleOf(strategy)
  // Toolchain provenance: the architect styles are certified by Leak XIV (Lean
  // 4.32.0), everything else by the Leak II/IV daemon (4.29.1). Reported per run
  // so the certificate can state what ACTUALLY checked the proof instead of
  // assuming one group — the two are NOT interchangeable.
  {
    const tc = toolchainForStyle(style)
    metrics.lean_toolchain = tc.lean
    metrics.mathlib_version = tc.mathlib
    metrics.verifier_group = tc.group
  }
  // Admin debug log: the exact prompt(s) the agent(s) receive.
  send({
    type: "prompt",
    prompt:
      style === "architect"
        ? `[LEAK RIVER — ${pickStrategy(strategy).label}]\n\n=== C.1 BLUEPRINT GENERATION ===\n` +
          architectBlueprintSystem() +
          "\n\n=== C.2 THEOREM PROVING (per node) ===\n" +
          architectProverSystem() +
          "\n\n=== C.3 BLUEPRINT REFINEMENT ===\n" +
          architectRefineSystem()
        : style === "have"
        ? `[DECOMPOSITION MODE — have-based (flat, single agent) · strategy: ${strategy}]\n\n=== PROVER PROMPT ===\n` +
          haveProvePrompt(theorem, mcpServers)
        : style === "have-tree"
          ? `[DECOMPOSITION MODE — have-tree (planner + isolated per-hole minions) · strategy: ${strategy}]\n\n=== PLANNER PROMPT ===\n` +
            haveTreePlannerPrompt(theorem, mcpServers) +
            "\n\n=== HOLE-FILL (MINION) PROMPT ===\n" +
            haveHoleFillPrompt("<the planner's verified skeleton>", "hN", mcpServers)
          : `[DECOMPOSITION MODE — proof tree · strategy: ${strategy}]\n\n=== NODE-PROVER PROMPT ===\n` +
            nodePromptFor(strategy, theorem, mcpServers, "(+ optional early-DECOMPOSE handoff)") +
            "\n\n=== DECOMPOSER PROMPT ===\n" +
            decomposePromptFor(strategy, theorem, mcpServers),
    model: opts.model || null,
    strategy,
    theorem,
    mcpServers: (mcpServers || []).map((s) => ({
      name: s?.name,
      url: s?.url,
      tools: Array.isArray(s?.tools)
        ? s.tools.map((t) => (typeof t === "string" ? t : t?.name)).filter(Boolean)
        : undefined,
    })),
  })

  const verifyUrl = resolveVerifyUrl(mcpServers)
  if (!verifyUrl && style !== "architect") {
    emit({ type: "error", message: "No verify_full_script MCP server is connected — decomposition needs one to gate scaffolds." })
    send({ type: "done", metrics, verified: false, proof: "" })
    res.end()
    return
  }

  // Optional WALL-CLOCK budget for the whole run (minutes the operator allots).
  // 0 / absent ⇒ uncapped (deadline Infinity), preserving the old behavior. When
  // set, the deadline is mutable and the UI can push it out live via /extend.
  const rawBudget = Number(opts.computeBudgetMs)
  const budgetMs =
    Number.isFinite(rawBudget) && rawBudget > 0
      ? Math.min(Math.max(rawBudget, 60000), 21600000)
      : 0
  // Leak River's refinement budget lives on the run state too, so the UI's
  // "+1 iter" button can raise it mid-flight (see /extend). Meaningless for the
  // other styles, which have no blueprint loop.
  const iterBudget = style === "architect" ? clampNum(opts.maxIters, 1, 32, ARCHITECT_MAX_ITERS) : 0
  const { runId, st: runState } = registerRun(budgetMs, iterBudget)
  // Tell the client its runId + current budgets so it can render the limit
  // indicators and target /extend. Architect runs always get the frame (the
  // iteration button needs a runId even on an uncapped clock); the others only
  // when a wall-clock budget was requested.
  if (budgetMs > 0 || iterBudget > 0)
    send({ type: "run", runId, deadlineMs: runState.deadlineMs, budgetMs: runState.budgetMs, maxIters: runState.maxIters })

  const abort = new AbortController()
  const ctx = {
    mcpServers,
    model: opts.model,
    strategy,
    // Resume seed: a previously-saved checkpoint (a partially-filled skeleton —
    // banked `have`s proven, the rest still `sorry`). When present, we skip
    // planning + isolated minions and finish straight from it (proveHaveFlat's
    // seed path), so saved progress is never re-derived. Empty ⇒ fresh run.
    seed: typeof opts.seed === "string" && opts.seed.trim() ? opts.seed : null,
    searchBudget: searchBudgetFor(strategy),
    verifyUrl,
    emit,
    metrics,
    signal: abort.signal,
    // THE single governor for the have/have-tree paths: one live wall-clock
    // deadline shared by the planner, every minion, and the finisher. Subprocess
    // killers poll it, so the "+5 min" /extend rescues whichever stage is running.
    // No turn caps anywhere on these paths — TIME alone bounds them.
    getDeadline: () => runState.deadlineMs,
    // Live refinement budget for the architect loop — same mutable-state trick as
    // getDeadline, so "+1 iter" reaches a run already on its last iteration.
    getMaxIters: () => runState.maxIters,
    computeGoverned: budgetMs > 0,
    // Turn budgets below are used ONLY by the lemma-style prove-or-split tree
    // (proveNode), where the budget doubles as a "force a decomposition after N
    // turns" trigger. The have-tree/have paths ignore them (time-governed).
    turnBudget: clampNum(opts.turnBudget, 1, 40, 10),
    minionTurnBudget: clampNum(opts.minionTurnBudget, 5, 300, 40),
    decomposeTurnBudget: clampNum(opts.decomposeTurnBudget, 1, 40, 12),
    maxDepth: clampNum(opts.maxDepth, 1, 6, 3),
    maxNodes: clampNum(opts.maxNodes, 1, 64, 24),
    // #5: how many times a node may re-decompose (with a DIFFERENT split) after
    // a child lemma or the assembly fails, before the node itself fails.
    maxRedecompose: clampNum(opts.maxRedecompose, 0, 5, 1),
    haveTurnBudget: clampNum(opts.haveTurnBudget, 5, 60, 24),
    // 0 = no per-node timeout (default) — hard leaves shouldn't be killed
    // mid-proof; Terminate aborts the whole tree. Positive value opts into a cap.
    nodeTimeoutMs: Number(opts.nodeTimeoutMs) > 0 ? clampNum(opts.nodeTimeoutMs, 30000, 21600000, 900000) : 0,
    verifyTimeoutMs: 180000,
    // Short leash for the disproof pre-check so a heavy/undecidable body can't
    // stall the whole run at the daemon (env REFUTE_TIMEOUT_MS or opts).
    refuteTimeoutMs: clampNum(opts.refuteTimeoutMs, 3000, 120000, REFUTE_TIMEOUT_MS_DEFAULT),
    nodeCount: 0,
    stage: "",
  }
  res.on("close", () => {
    ACTIVE_RUNS.delete(runId)
    if (!res.writableEnded) abort.abort()
  })

  const root = {
    id: "T",
    signature: theoremSignature(theorem),
    statement: theorem,
    status: "open",
    children: [],
    depth: 0,
  }

  ;(async () => {
    try {
      let ok = false
      let proof = ""
      if (style === "architect") {
        const r = await proveArchitect(theorem, ctx, opts)
        ok = r.verified
        proof = r.proof
        if (ok && proof) {
          emit({ type: "message-annotation", subtype: "status", thought: "✅ System check passed — Leak XIV certified the assembled blueprint proof." })
          send({ type: "text-delta", content: `✅ **Verified proof** (Goedel-Architect blueprint, certified by Leak XIV):\n\n\`\`\`lean\n${proof}\n\`\`\`` })
        } else {
          emit({ type: "message-annotation", subtype: "error", thought: "❌ System check failed — the architect pipeline did not produce a certified proof." })
          send({ type: "text-delta", content: "⚠️ Not accepted — the architect run did not produce a certified, sorry-free proof of the target." })
        }
      } else if (style === "have" || style === "have-tree") {
        // `have`: one agent, whole proof in one context. `have-tree`: planner +
        // isolated per-hole minions (linear context), falling back to `have`.
        // Resuming from a saved checkpoint short-circuits both: finish the
        // remaining holes straight from the seed (proven work is handed in, not
        // rediscovered). The independent verify gate is unchanged, so soundness
        // is identical to a from-scratch run.
        let r
        if (ctx.seed) {
          emit({ type: "message-annotation", subtype: "status", thought: "▶️ Resuming from a saved checkpoint — finishing the remaining hole(s) from banked progress." })
          r = await proveHaveFlat(theorem, ctx, { seed: ctx.seed })
        } else {
          r = style === "have-tree" ? await proveHaveTree(theorem, ctx) : await proveHaveFlat(theorem, ctx)
        }
        ok = r.verified
        proof = r.proof
        if (ok && proof) {
          emit({ type: "message-annotation", subtype: "status", thought: "✅ System check passed — have-based proof verified sorry-free." })
          send({ type: "text-delta", content: `✅ **Verified proof** (in-context \`have\` decomposition, confirmed by verify_full_script):\n\n\`\`\`lean\n${proof}\n\`\`\`` })
        } else {
          emit({ type: "message-annotation", subtype: "error", thought: "❌ System check failed — the have-based proof did not verify." })
          send({ type: "text-delta", content: "⚠️ Not accepted — the have-based run did not produce a verified, sorry-free proof of the target." })
        }
      } else {
        // Top-level-lemma prove-or-split tree.
        emit({ type: "message-annotation", subtype: "status", thought: `🌲 Decomposition mode [${strategy}]: prove-or-split, ${ctx.turnBudget} turns/node, depth ≤ ${ctx.maxDepth}.` })
        ok = await proveNode(root, ctx)
        proof = ok ? root.proof : ""
        if (ok && proof) {
          emit({ type: "message-annotation", subtype: "status", thought: "✅ System check passed — full tree assembled and verified sorry-free." })
          send({ type: "text-delta", content: `✅ **Verified proof** (decomposition tree, confirmed by verify_full_script):\n\n\`\`\`lean\n${proof}\n\`\`\`` })
        } else {
          emit({ type: "message-annotation", subtype: "error", thought: "❌ System check failed — the tree did not close every leaf." })
          send({ type: "text-delta", content: "⚠️ Not accepted — the decomposition tree did not produce a verified, sorry-free proof of the target." })
        }
      }
      send({ type: "done", metrics, verified: !!(ok && proof), proof })
    } catch (e) {
      emit({ type: "error", message: `tree error: ${String(e?.message || e)}` })
      send({ type: "done", metrics, verified: false, proof: "" })
    } finally {
      ACTIVE_RUNS.delete(runId)
      res.end()
    }
  })()
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`)

  // The search governor is an MCP-SSE server the LOCAL `claude` process talks to.
  // It carries no bridge token / browser Origin, so it is handled BEFORE the CORS
  // + token gate. The whole bridge binds 127.0.0.1 only, and these routes proxy
  // read-only library search behind a per-run id, so this is safe.
  const govMatch = url.pathname.match(/^\/gov\/([^/]+)\/(sse|message)$/)
  if (govMatch) {
    const [, govId, kind] = govMatch
    if (req.method === "GET" && kind === "sse") return governorSse(req, res, govId)
    if (req.method === "POST" && kind === "message")
      return governorMessage(req, res, govId, url.searchParams.get("sessionId"))
    res.writeHead(405)
    res.end()
    return
  }

  const allowed = setCors(req, res)

  if (req.method === "OPTIONS") {
    res.writeHead(allowed ? 204 : 403)
    res.end()
    return
  }
  if (!allowed) return json(res, 403, { error: "origin_not_allowed" })
  if (!tokenValid(req)) return json(res, 401, { error: "invalid_token" })

  try {
    if (req.method === "GET" && url.pathname === "/health") {
      const v = await getVersion()
      return json(res, 200, { ok: v.ok, version: v.version, error: v.error })
    }

    if (req.method === "POST" && url.pathname === "/run") {
      const body = JSON.parse((await readBody(req)) || "{}")
      const prompt = body.prompt
      if (typeof prompt !== "string" || !prompt.trim()) {
        return json(res, 400, { error: "prompt_required" })
      }
      const options = body.options || {}
      // timeoutMs === 0 means "no cap" — the browser's Terminate button controls
      // it instead (and disconnecting kills the process, see killSignal below).
      const timeoutMs =
        Number(options.timeoutMs) === 0
          ? 0
          : Math.min(Math.max(Number(options.timeoutMs) || 120000, 5000), 1800000)
      const cwd =
        typeof options.workingDirectory === "string" && options.workingDirectory.trim()
          ? options.workingDirectory.trim()
          : undefined
      // Kill claude if the client disconnects before we respond (Terminate).
      const killer = new AbortController()
      res.on("close", () => {
        if (!res.writableEnded) killer.abort()
      })
      const result = await runClaude(buildArgs(prompt, options), {
        cwd,
        timeoutMs,
        killSignal: killer.signal,
        maxOutputTokens: Number(options.maxOutputTokens) || 0,
      })
      return json(res, 200, result)
    }

    // Streaming /run — same contract, but live SSE progress. See runStream.
    if (req.method === "POST" && url.pathname === "/run-stream") {
      const body = JSON.parse((await readBody(req)) || "{}")
      return runStream(res, body)
    }

    if (req.method === "POST" && url.pathname === "/prove") {
      const body = JSON.parse((await readBody(req)) || "{}")
      const theorem = body.theorem || body.prompt
      if (typeof theorem !== "string" || !theorem.trim()) {
        return json(res, 400, { error: "theorem_required" })
      }
      const result = await runProve(theorem, body.mcpServers || [], body.options || {})
      return json(res, 200, result)
    }

    if (req.method === "POST" && url.pathname === "/prove-stream") {
      const body = JSON.parse((await readBody(req)) || "{}")
      const theorem = body.theorem || body.prompt
      if (typeof theorem !== "string" || !theorem.trim()) {
        return json(res, 400, { error: "theorem_required" })
      }
      proveStream(res, theorem, body.mcpServers || [], body.options || {})
      return
    }

    // Push out a running prove's budget: wall-clock (the UI's "+5 min" button)
    // and/or Leak River refinement iterations (the "+1 iter" button). Mutates the
    // live values the run polls, so either rescues even the stage currently
    // executing. Behind the same token + CORS gate above.
    if (req.method === "POST" && url.pathname === "/extend") {
      const body = JSON.parse((await readBody(req)) || "{}")
      const runId = String(body.runId || "")
      const addIters = clampNum(body.addIters, 0, 32, 0)
      // Absent addMs means "+5 min" for back-compat, EXCEPT on a pure iteration
      // bump — clicking "+1 iter" must not silently buy wall-clock time too.
      const addMs =
        body.addMs == null && addIters > 0 ? 0 : clampNum(body.addMs, 60000, 3600000, 300000)
      const st = ACTIVE_RUNS.get(runId)
      if (!st) return json(res, 404, { error: "run_not_found" })
      if (addMs > 0) {
        // If the run was uncapped, base the fresh deadline on now.
        const base = Number.isFinite(st.deadlineMs) ? st.deadlineMs : Date.now()
        st.deadlineMs = base + addMs
        st.budgetMs = (Number.isFinite(st.budgetMs) ? st.budgetMs : 0) + addMs
      }
      if (addIters > 0) st.maxIters = Math.min((st.maxIters || 0) + addIters, 64)
      return json(res, 200, {
        ok: true,
        runId,
        deadlineMs: st.deadlineMs,
        budgetMs: st.budgetMs,
        addedMs: addMs,
        maxIters: st.maxIters,
        addedIters: addIters,
      })
    }

    // Decomposition orchestrator: prove-or-split proof tree. Same SSE shape as
    // /prove-stream, so the same client renders it.
    if (req.method === "POST" && url.pathname === "/prove-tree") {
      const body = JSON.parse((await readBody(req)) || "{}")
      const theorem = body.theorem || body.prompt
      if (typeof theorem !== "string" || !theorem.trim()) {
        return json(res, 400, { error: "theorem_required" })
      }
      proveTreeStream(res, theorem, body.mcpServers || [], body.options || {})
      return
    }

    return json(res, 404, { error: "not_found" })
  } catch (err) {
    return json(res, 500, { error: "bridge_error", detail: String(err) })
  }
})

// 127.0.0.1 ONLY — never bind 0.0.0.0.
server.listen(PORT, "127.0.0.1", () => {
  const line = "=".repeat(64)
  console.log(line)
  console.log("  Local Claude Agent bridge is running")
  console.log(line)
  console.log(`  URL:            http://localhost:${PORT}`)
  console.log(`  Token:          ${TOKEN}`)
  console.log(`  Allowed origins: localhost, ${ALLOWED_ORIGINS.join(", ")}`)
  console.log(line)
  console.log("  1. Paste the URL and Token above into the app's")
  console.log("     Local Agent → Configuration → Connection fields.")
  console.log("  2. Keep this terminal open while you use the feature.")
  console.log("  3. The token is a secret — anyone with it can drive your Claude.")
  console.log(line)
  // Diagnostic hook (off unless GOV_SELFTEST=<search server sse url>): stand up a
  // persistent governor so the search throttle can be exercised without an agent.
  if (process.env.GOV_SELFTEST) {
    const g = createGovernor()
    g.searchServer = {
      url: process.env.GOV_SELFTEST,
      tools: [
        { name: "loogle_search", argKey: "query" },
        { name: "moogle_search", argKey: "concept" },
      ],
    }
    console.log(`[gov-selftest] id=${g.id} budget=${g.budget} sse=http://127.0.0.1:${PORT}/gov/${g.id}/sse`)
  }
})

// ---------------------------------------------------------------------------
// Relay client (optional). When RELAY_URL + RELAY_TOKEN are set, this bridge
// also dials OUT to the app server and makes this machine available as an
// on-demand LLM provider for the server-side search. Pure outbound HTTP/SSE —
// nothing new is exposed on your network.
// ---------------------------------------------------------------------------
const RELAY_URL = (process.env.RELAY_URL || "").replace(/\/$/, "")
const RELAY_TOKEN = process.env.RELAY_TOKEN || ""

function firstToolArgKey(tool) {
  const required = tool?.function?.parameters?.required
  if (Array.isArray(required) && required.length) return required[0]
  const props = tool?.function?.parameters?.properties
  if (props && typeof props === "object") return Object.keys(props)[0] || "script"
  return "script"
}

// The tree injects its own control-flow directives (forcing native tool-call
// schema, "use propose_lean_tactic", etc.). Those read as prompt injection to
// Claude and make it refuse. Drop them; keep the goal and the real dialogue.
const TREE_META_PATTERNS = [
  /MANDATORY PROTOCOL/i,
  /SYSTEM REMINDER/i,
  /native tool execution schema/i,
  /you did not invoke any tools/i,
]

function messageText(m) {
  return typeof m.content === "string" ? m.content : JSON.stringify(m.content ?? "")
}

function messagesToPrompt(messages) {
  return messages
    .filter((m) => {
      const t = messageText(m)
      return !TREE_META_PATTERNS.some((rx) => rx.test(t))
    })
    .map((m) => `${String(m.role || "user").toUpperCase()}:\n${messageText(m)}`)
    .join("\n\n")
}

function extractScript(text) {
  const fence = text.match(/```(?:lean\w*)?\s*([\s\S]*?)```/i)
  return (fence ? fence[1] : text).trim()
}

// Describe the offered tools so Claude can pick one and fill its parameters.
function toolsSummary(tools) {
  return tools
    .map((t) => {
      const f = t.function || t
      return `- ${f.name}: ${f.description || ""}\n  parameters: ${JSON.stringify(f.parameters || {})}`
    })
    .join("\n")
}

// Parse Claude's JSON tool choice and validate the name against the offered set.
function parseToolChoice(text, tools) {
  const m = text.match(/\{[\s\S]*\}/)
  if (!m) return null
  try {
    const obj = JSON.parse(m[0])
    const name = obj.tool || obj.name
    const known = tools.some((t) => (t.function?.name || t.name) === name)
    if (!name || !known) return null
    return { name, arguments: obj.arguments || obj.args || {} }
  } catch {
    return null
  }
}

function toolCallResponse(name, args) {
  return {
    response: {
      content: "",
      tool_calls: [
        {
          id: `call_${randomBytes(6).toString("hex")}`,
          type: "function",
          function: { name, arguments: JSON.stringify(args) },
        },
      ],
      finish_reason: "tool_calls",
      usage: {},
    },
  }
}

// True if the tool arguments actually carry something (not {} or {"script":""}).
function argsHaveContent(args) {
  if (!args || typeof args !== "object") return false
  return Object.values(args).some((v) =>
    typeof v === "string" ? v.trim().length > 0 : v != null,
  )
}

// Best fallback tool when Claude returns a bare script instead of JSON.
// Prefer the fast tools; never fall back to the slow propose_lean_tactic.
function preferredTool(tools) {
  const nameOf = (t) => t.function?.name || t.name || ""
  return (
    tools.find((t) => /apply.*tactic|verify.*script|init.*proof/i.test(nameOf(t))) ||
    tools.find((t) => !/propose/i.test(nameOf(t))) ||
    tools[0]
  )
}

// Turn one OpenAI-style request into a Claude run, then an OpenAI-style result.
// Claude is framed as the reasoning engine for an EXTERNAL harness (your tree),
// which executes the chosen action and gates on the Lean result — so it's
// directing a harness, not fabricating calls to tools it doesn't own.
async function handleRelayRequest(payload) {
  const messages = Array.isArray(payload?.messages) ? payload.messages : []
  const tools = Array.isArray(payload?.tools) ? payload.tools : []

  let prompt = messagesToPrompt(messages)
  if (tools.length > 0) {
    prompt += `\n\n---\nYou are the reasoning engine for an external Lean 4 proof-search harness. The harness — not you — executes the action you choose against its own Lean backend and checks the result. This is a legitimate orchestration: you are directing the harness, not calling your own tools.\n\nAvailable actions the harness can run:\n${toolsSummary(tools)}\n\nChoose ONE action for the next step and reply with ONLY this JSON object — no prose, no code fences:\n{"tool": "<action name>", "arguments": { ...its parameters... }}`
  }

  const result = await runClaude(buildArgs(prompt, {}), { cwd: undefined, timeoutMs: 600000 })
  if (!result.ok) return { error: result.stderr || "claude run failed" }

  if (tools.length > 0) {
    const choice = parseToolChoice(result.text, tools)
    if (choice && argsHaveContent(choice.arguments)) {
      return toolCallResponse(choice.name, choice.arguments)
    }
    // Fallback: wrap a bare script into the most likely action — but ONLY if
    // there's actually a script. An empty tool call just hangs the MCP server.
    const script = extractScript(result.text)
    if (script) {
      const tool = preferredTool(tools)
      const name = tool.function?.name || tool.name || "tool"
      return toolCallResponse(name, { [firstToolArgKey(tool)]: script })
    }
    // Nothing usable — return the text so the tree surfaces it instead of
    // calling a tool with an empty script.
    return { response: { content: result.text || "(the model produced no script)", finish_reason: "stop", usage: {} } }
  }

  return { response: { content: result.text, finish_reason: "stop", usage: {} } }
}

async function postResult(requestId, out) {
  await fetch(`${RELAY_URL}/api/local-claude/agent/result`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-relay-token": RELAY_TOKEN },
    body: JSON.stringify({ requestId, ...out }),
  }).catch((e) => console.error("[relay] result POST failed:", e.message))
}

async function connectRelay() {
  const url = `${RELAY_URL}/api/local-claude/agent?token=${encodeURIComponent(RELAY_TOKEN)}`
  for (;;) {
    try {
      console.log(`[relay] connecting to ${RELAY_URL} ...`)
      const res = await fetch(url, { headers: { accept: "text/event-stream" } })
      if (!res.ok || !res.body) throw new Error(`relay responded ${res.status}`)
      console.log("[relay] connected — this machine is available to the app.")

      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ""
      for (;;) {
        const { value, done } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        let sep
        while ((sep = buffer.indexOf("\n\n")) !== -1) {
          const raw = buffer.slice(0, sep)
          buffer = buffer.slice(sep + 2)
          let event = ""
          let data = ""
          for (const l of raw.split("\n")) {
            if (l.startsWith("event:")) event = l.slice(6).trim()
            else if (l.startsWith("data:")) data = l.slice(5).trim()
          }
          if (event === "request" && data) {
            const { requestId, payload } = JSON.parse(data)
            handleRelayRequest(payload)
              .then((out) => postResult(requestId, out))
              .catch((e) => postResult(requestId, { error: e.message }))
          }
        }
      }
    } catch (e) {
      console.error("[relay] disconnected:", e.message)
    }
    await new Promise((r) => setTimeout(r, 3000))
  }
}

if (RELAY_URL && RELAY_TOKEN) {
  connectRelay()
}

// ---------------------------------------------------------------------------
// Worker mode (optional). When WORKER_URL + WORKER_SECRET are set, this machine
// also drains the app's deployment queue (the Leak API service): it leases a
// queued problem, proves it with the SAME runProve() that backs /prove,
// heartbeats while proving, and posts the result back. It reuses the app's
// worker data-plane (/api/worker/lease|heartbeat|complete) and everything the
// bridge already has (claude spawn, prove prompt, mcp config, timeouts).
// ---------------------------------------------------------------------------
const WORKER_URL = (process.env.WORKER_URL || "").replace(/\/$/, "")
const WORKER_SECRET = process.env.WORKER_SECRET || ""
const WORKER_ID = process.env.WORKER_ID || `bridge-${process.pid}`
const WORKER_POLL_MS = Math.max(Number(process.env.WORKER_POLL_MS) || 5000, 1000)
// Empty model => the CLI's configured default (i.e. the operator's Max plan).
const WORKER_MODEL = process.env.WORKER_MODEL || ""
// 'operator' => this bridge drains ONLY jobs an admin delegated to it (and the
// autonomous hosted worker skips those). Anything else => a normal worker that
// takes the shared queue but skips delegated jobs. Default: 'operator', since a
// hand-run bridge is the operator's own machine.
const WORKER_KIND =
  (process.env.WORKER_KIND || "operator").toLowerCase() === "hosted"
    ? "hosted"
    : "operator"
// Prover MCP servers the agent may drive. Provided by the lease response when
// the app supplies them, else from WORKER_MCP_CONFIG (a JSON array), else none.
let WORKER_MCP = []
try {
  WORKER_MCP = process.env.WORKER_MCP_CONFIG
    ? JSON.parse(process.env.WORKER_MCP_CONFIG)
    : []
} catch {
  console.error("[worker] WORKER_MCP_CONFIG is not valid JSON — ignoring")
}

function workerHeaders() {
  return { "content-type": "application/json", "x-worker-secret": WORKER_SECRET }
}

async function leaseJob() {
  const res = await fetch(`${WORKER_URL}/api/worker/lease`, {
    method: "POST",
    headers: workerHeaders(),
    body: JSON.stringify({ workerId: WORKER_ID, kind: WORKER_KIND }),
  })
  if (!res.ok) throw new Error(`lease responded ${res.status}`)
  const data = await res.json()
  return data.job || null
}

async function workerComplete(jobId, body) {
  await fetch(`${WORKER_URL}/api/worker/complete`, {
    method: "POST",
    headers: workerHeaders(),
    body: JSON.stringify({ jobId, workerId: WORKER_ID, ...body }),
  }).catch((e) => console.error("[worker] complete POST failed:", e.message))
}

async function workerHeartbeat(jobId) {
  await fetch(`${WORKER_URL}/api/worker/heartbeat`, {
    method: "POST",
    headers: workerHeaders(),
    body: JSON.stringify({ jobId, workerId: WORKER_ID, status: "proving" }),
  }).catch(() => {})
}

async function proveLeasedJob(job) {
  const mcp = Array.isArray(job.mcpServers) ? job.mcpServers : WORKER_MCP
  // Keep the lease alive across a long proof (lease window is minutes).
  const beat = setInterval(() => workerHeartbeat(job.id), 30000)
  try {
    const out = await runProve(job.problem, mcp, {
      model: WORKER_MODEL || undefined,
      // Abort mid-run if the metered charge would exhaust the balance. The app
      // hands us the ceiling on lease (balance / (markup × fx)).
      maxCostUsd:
        typeof job.maxCostUsd === "number" ? job.maxCostUsd : Number.POSITIVE_INFINITY,
    })
    clearInterval(beat)
    const modelId = WORKER_MODEL || "claude"
    const costUsd = typeof out.costUsd === "number" ? out.costUsd : 0
    // Pay-for-compute: report costUsd either way so the app bills 1.2× actual on
    // success OR failure. Complete (proof) only on a daemon-verified script.
    if (out.verified && out.proof && out.proof.trim()) {
      await workerComplete(job.id, { proof: out.proof, costUsd, modelId })
      console.log(`[worker] proved ${job.id} in ${out.durationMs}ms ($${costUsd.toFixed(4)})`)
    } else {
      const error = out.budgetExceeded
        ? "aborted: run cost would exceed remaining balance"
        : out.timedOut
          ? "prover timed out"
          : out.stderr || "no verified proof produced"
      await workerComplete(job.id, { error, costUsd, modelId })
      console.log(`[worker] failed ${job.id} ($${costUsd.toFixed(4)}): ${error.slice(0, 120)}`)
    }
  } catch (e) {
    clearInterval(beat)
    await workerComplete(job.id, { error: e.message, costUsd: 0 })
  }
}

async function workerLoop() {
  console.log(`[worker] draining queue at ${WORKER_URL} as ${WORKER_ID}`)
  for (;;) {
    let got = false
    try {
      const job = await leaseJob()
      if (job) {
        console.log(`[worker] leased ${job.id}`)
        await proveLeasedJob(job)
        got = true // a job was handled — loop again immediately
      }
    } catch (e) {
      console.error("[worker] lease error:", e.message)
    }
    if (!got) await new Promise((r) => setTimeout(r, WORKER_POLL_MS))
  }
}

if (WORKER_URL && WORKER_SECRET) {
  workerLoop()
}
