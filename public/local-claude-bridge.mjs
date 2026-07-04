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
import { randomBytes, timingSafeEqual } from "node:crypto"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const PORT = Number(process.env.PORT || 4123)
const CLAUDE_BIN = process.env.CLAUDE_BIN || "claude"
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

// The goal is to let Claude use the tools logically on its own — but a bare
// "prove this" makes it fall into an endless moogle/loogle syntax-search spiral
// on hard theorems and never actually build or check a proof. So we hand it an
// explicit, verification-first workflow: draft → verify_full_script → iterate,
// with library search as a *subordinate* step, not the main loop.
function provePrompt(theorem, mcpServers = []) {
  // Claude Code prefixes MCP tools as mcp__<server>__<tool>, sanitizing the
  // server name (e.g. "Leak II" -> "Leak_II"). We build the tool list from the
  // LIVE inventory the app pulled from the MCP manager (name + arg keys), so the
  // agent gets exact tool ids and can't invent one like "mcp__Lean_I__...".
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

  // These MCP tools are DEFERRED by Claude Code (verified against the live CLI):
  // a tool CANNOT be called until it has been loaded with ToolSearch
  // "select:<exact id>". So the reliable pattern is to select ALL of them up
  // front, then call them. Telling the agent to "call directly / skip
  // ToolSearch" is what made earlier runs fail with "No such tool available".
  let toolSection
  if (toolIds.length) {
    toolSection = `Your Lean tools are provided over MCP but are DEFERRED — you MUST load a tool before you can call it. As your VERY FIRST action, make ONE ToolSearch call to load them all:

  ToolSearch  query: "select:${toolIds.join(",")}"

After that they are callable by these EXACT names (never invent a name):
${toolLines.join("\n")}

If ToolSearch returns nothing for a given id, that tool's server isn't connected right now — proceed with whichever loaded. If verify_full_script fails to load, say so explicitly and stop; do not fake a verification.`
  } else if (servers.length) {
    const prefixes = servers.map((s) => sanitize(s.name))
    toolSection = `Your Lean tools are provided over MCP by these servers: ${prefixes.join(", ")}. They are DEFERRED, so load them first with ONE ToolSearch call before calling any:

  ToolSearch  query: "select:${prefixes.map((p) => `mcp__${p}__verify_full_script`).join(",")},${prefixes.map((p) => `mcp__${p}__moogle_search`).join(",")},${prefixes.map((p) => `mcp__${p}__loogle_search`).join(",")},${prefixes.map((p) => `mcp__${p}__init_proof`).join(",")},${prefixes.map((p) => `mcp__${p}__apply_tactic`).join(",")}"

Only the ids that actually exist will load; use those. Never invent a server name. If verify_full_script does not load on any server, say so and stop.`
  } else {
    toolSection =
      'Load your Lean MCP tools first with ToolSearch "select:mcp__<server>__<tool>" (they are deferred), then use a whole-script compiler (verify_full_script) and library search.'
  }

  return `You are proving the following Lean 4 theorem.

${toolSection}

Tool roles: verify_full_script compiles a whole script and is your source of truth (a proof only counts when it reports success with no errors and no \`sorry\`); init_proof/apply_tactic advance a goal incrementally; moogle_search/loogle_search look up lemma names.

WORKFLOW — follow it in order, do not get stuck searching:
0. Load the tools (ToolSearch select, as above). This is mandatory and comes first.
1. Immediately write a first candidate proof script based on the goal (start from the statement below, replacing \`sorry\` with your best attempt) and call verify_full_script on it. Do this BEFORE any library search — you learn the most from the compiler's actual errors.
2. Read the compiler errors and fix them. Iterate: edit the script and call verify_full_script again. If the tactic tools work, use them to advance the goal step by step and confirm each step compiles. (If init_proof/apply_tactic return a server error, don't retry them in a loop — fall back to editing the full script and verify_full_script.)
3. Only use moogle_search / loogle_search when you need a SPECIFIC lemma name to close a specific goal — at most a couple of lookups, then go straight back to verify_full_script. Do not enumerate the library; do not search without an attempt to verify in between.
4. A proof is done ONLY when verify_full_script reports success with no errors and no \`sorry\`. Keep iterating until then.
5. Then output the final verified proof as a single \`\`\`lean code block.

Never end by only having searched. Every few turns you must have called verify_full_script.

Theorem:
${theorem}`
}

async function runProve(theorem, mcpServers, opts = {}) {
  const start = Date.now()

  let cfgPath
  try {
    const dir = mkdtempSync(join(tmpdir(), "claude-prove-"))
    cfgPath = join(dir, "mcp.json")
    writeFileSync(cfgPath, JSON.stringify(buildMcpConfig(mcpServers)))
  } catch (e) {
    return { ok: false, proof: "", stderr: `failed to write mcp config: ${e.message}`, durationMs: 0 }
  }

  // Flags verified against Claude Code 2.1.x: strict-mcp-config uses only these
  // servers, dangerously-skip-permissions lets the agent call the MCP tools
  // without prompting (it's the user's own machine + own tools).
  const args = [
    "-p", provePrompt(theorem, mcpServers),
    "--output-format", "json",
    "--mcp-config", cfgPath,
    "--strict-mcp-config",
    "--dangerously-skip-permissions",
  ]
  if (opts.model) args.push("--model", opts.model)

  const timeoutMs = Math.min(Math.max(Number(opts.timeoutMs) || 1800000, 30000), 3600000)
  const result = await runClaude(args, { cwd: opts.workingDirectory || undefined, timeoutMs })

  return {
    ok: result.ok,
    proof: result.text,
    exitCode: result.exitCode,
    durationMs: Date.now() - start,
    timedOut: result.timedOut,
    stderr: result.stderr,
  }
}

// Streaming variant of /prove: runs Claude with stream-json and translates each
// event into the app's SSE shape (message-annotation for tool activity,
// text-delta for the final proof) so the main chat's activity panel renders it.
function proveStream(res, theorem, mcpServers, opts = {}) {
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

  const args = [
    "-p", provePrompt(theorem, mcpServers),
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

  const start = Date.now()
  const metrics = { tools_invoked: 0, llm_invocations: 0, time_elapsed: 0 }
  const stripName = (n) => String(n || "").replace(/^mcp__[a-z0-9-]+__/i, "")

  // System gate: the ONE enforced restriction. We only accept a proof that the
  // harness itself watched pass verify_full_script — not one Claude merely
  // claims. Map each verify_full_script call id -> its script, and record the
  // script when the matching result reports success.
  const verifyCalls = {}
  let verifiedScript = null

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

  const timeoutMs = Math.min(Math.max(Number(opts.timeoutMs) || 900000, 30000), 3600000)
  const timer = setTimeout(() => {
    send({ type: "error", message: "Prover timed out." })
    child.kill("SIGKILL")
  }, timeoutMs)

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
      metrics.time_elapsed = Math.round((Date.now() - start) / 1000)

      if (o.type === "assistant" && o.message?.content) {
        metrics.llm_invocations++
        for (const c of o.message.content) {
          if (c.type === "tool_use") {
            metrics.tools_invoked++
            const name = stripName(c.name)
            if (
              String(c.name || "").endsWith("verify_full_script") &&
              c.input &&
              typeof c.input === "object" &&
              typeof c.input.script === "string"
            ) {
              verifyCalls[c.id] = c.input.script
            }
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
          }
        }
      } else if (o.type === "user" && o.message?.content) {
        for (const c of o.message.content) {
          if (c.type === "tool_result") {
            const t = Array.isArray(c.content)
              ? c.content.map((x) => x.text || "").join("\n")
              : String(c.content ?? "")
            if (
              c.tool_use_id &&
              verifyCalls[c.tool_use_id] &&
              /compilation successful|100% verified|no goals/i.test(t)
            ) {
              verifiedScript = verifyCalls[c.tool_use_id]
            }
            send({ type: "message-annotation", subtype: "tool_result", thought: "Tool output", output: t, metrics })
          }
        }
      } else if (o.type === "result") {
        finalText = o.result || ""
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

const server = createServer(async (req, res) => {
  const allowed = setCors(req, res)

  if (req.method === "OPTIONS") {
    res.writeHead(allowed ? 204 : 403)
    res.end()
    return
  }
  if (!allowed) return json(res, 403, { error: "origin_not_allowed" })
  if (!tokenValid(req)) return json(res, 401, { error: "invalid_token" })

  const url = new URL(req.url, `http://localhost:${PORT}`)

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
