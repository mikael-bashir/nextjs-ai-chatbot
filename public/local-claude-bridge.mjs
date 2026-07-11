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
  const r = await callRemoteMcpTool(srv.url, toolName, args, { timeoutMs: 60000 })
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
    reply({ tools })
  } else if (method === "tools/call") {
    const text = await governedSearchCall(g, msg.params?.name, msg.params?.arguments || {})
    reply({ content: [{ type: "text", text }] })
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
    const done = (out) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try {
        reader?.cancel()
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
      })
      if (!res.ok && !notify) throw new Error(`POST ${method} -> ${res.status}`)
      return p
    }
    ;(async () => {
      try {
        const res = await fetch(sseUrl, { headers: { Accept: "text/event-stream" } })
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
function verifyViaDaemon(script, sseUrl, { timeoutMs = 180000 } = {}) {
  return callRemoteMcpTool(sseUrl, /verify.*full.*script|verify_full_script/i, { script }, { timeoutMs })
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
function haveProvePrompt(theorem, mcpServers = [], extra = "") {
  const toolSection = mcpToolSection(mcpServers)
  return `You are proving a Lean 4 + Mathlib theorem by IN-CONTEXT DECOMPOSITION. You write ONE self-contained proof of the theorem and break every hard step into a LOCAL \`have\`, NEVER a top-level helper lemma.

${toolSection}

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
    label: "Have-tree — planner + isolated per-hole minions (linear context)",
    node: (t, m, x) => haveTreePlannerPrompt(t, m, x),
    decompose: (t, m, x) => haveHoleFillPrompt("<the verified skeleton>", "hN", m, x),
    search: GOV_INITIAL,
    style: "have-tree",
  },
}
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
        const ev = gate.observe(o)
        if (ev?.verified) {
          // Target proved and daemon-confirmed — stop now instead of letting the
          // agent wander to the timeout; the close handler resolves the result.
          try {
            child.kill("SIGKILL")
          } catch {
            /* already gone */
          }
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
        stderr,
      })
    })
  })
}

// Streaming variant of /prove: runs Claude with stream-json and translates each
// event into the app's SSE shape (message-annotation for tool activity,
// text-delta for the final proof) so the main chat's activity panel renders it.
// Single-agent SSE entrypoint. Wrapper runs the disproof pre-check FIRST (a
// false master is refuted in seconds instead of spawning the prover), then hands
// off to proveStreamRun for the actual proof attempt.
async function proveStream(res, theorem, mcpServers, opts = {}) {
  theorem = normalizeProblemSyntax(theorem)
  if (opts.refuteCheck !== false) {
    const verifyUrl = resolveVerifyUrl(mcpServers)
    const rctx = { verifyUrl, verifyTimeoutMs: 180000, refuteTimeoutMs: REFUTE_TIMEOUT_MS_DEFAULT, signal: undefined }
    if (verifyUrl) {
      const pre = await refutePreCheck(theorem, rctx)
      if (pre.refuted) {
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache, no-transform" })
        const send = (o) => {
          try {
            res.write(`data: ${JSON.stringify(o)}\n\n`)
          } catch {
            /* client gone */
          }
        }
        const metrics = { tools_invoked: 0, llm_invocations: 0, time_elapsed: 0 }
        const w = pre.witness
        const cex = w != null ? `counterexample at the first argument = ${w}` : "a small counterexample"
        send({ type: "prompt", prompt: "[REFUTED before proving — the theorem is false]", theorem, model: opts.model || null, mcpServers: (mcpServers || []).map((s) => ({ name: s?.name, url: s?.url })) })
        send({ type: "message-annotation", subtype: "error", thought: `↯ Master theorem is FALSE — ${cex}. Machine-checked disproof; skipping the prover.`, metrics })
        send({ type: "text-delta", content: `↯ **Refuted** — the theorem is false (${cex}), verified by Lean:\n\n\`\`\`lean\n${pre.script}\n\`\`\`` })
        send({ type: "done", metrics, verified: false, refuted: true, counterexample: cex, proof: "", disproof: pre.script })
        res.end()
        return
      }
    }
  }
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

  const systemPrompt = provePrompt(theorem, mcpServers, REFUTE_NOTE)
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
  const metrics = { tools_invoked: 0, llm_invocations: 0, time_elapsed: 0 }
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
      if (ev?.verified) {
        // Target theorem proved. Claude won't self-terminate on a tool success,
        // so stop it now instead of letting it wander until the timeout; the
        // close handler emits the verified proof.
        try {
          child.kill("SIGKILL")
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
const ACTIVE_RUNS = new Map() // runId -> { deadlineMs, budgetMs }
function registerRun(budgetMs) {
  const runId = randomUUID()
  const st = {
    deadlineMs: budgetMs > 0 ? Date.now() + budgetMs : Infinity,
    budgetMs: budgetMs > 0 ? budgetMs : 0,
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
function spawnProverStream({ prompt, mcpServers, model, maxTurns, timeoutMs, getDeadline, stage, metrics, signal, searchBudget }, { onObject, emit }) {
  return new Promise((resolve) => {
    // Each subagent run gets its OWN search governor (budget resets per node /
    // per decomposition — a fresh sub-goal earns a fresh allowance). The initial
    // budget is strategy-dependent (e.g. librarian gets a large one). Search tools
    // are routed through the bridge; verify + Pantograph stay direct.
    const governor = createGovernor({ initial: searchBudget })
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
    ]
    if (model) args.push("--model", model)
    if (Number.isFinite(maxTurns) && maxTurns > 0) args.push("--max-turns", String(Math.floor(maxTurns)))

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
        if (o.type === "result") finalText = o.result || finalText
        if (stop && !stopped) {
          stopped = true
          kill()
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
  let refuteText = ""
  // #2: the node prover's stream already SEES every compile error and tactic
  // state; capture the most recent ones so a forced decomposition can be told
  // exactly where the direct attempt got stuck instead of rediscovering it.
  const verifyIds = new Set()
  let lastVerifyError = ""
  let lastGoalState = ""
  const extra =
    "EARLY DECOMPOSE (optional): if partway through you judge this goal is too large to close directly and would be better split into sub-lemmas, output a line that is exactly `DECOMPOSE: <one-line reason>` and stop — a dedicated decomposition run will then take over. Only do this when genuinely stuck; prefer to finish the proof if you can.\n" +
    REFUTE_NOTE
  const prompt = nodePromptFor(ctx.strategy, node.statement, ctx.mcpServers, extra)
  const onObject = (o) => {
    const ev = gate.observe(o)
    if (ev?.verified) return true
    if (o.type === "assistant" && o.message?.content) {
      for (const c of o.message.content) {
        if (c.type === "tool_use" && c.id && String(c.name || "").endsWith("verify_full_script"))
          verifyIds.add(c.id)
        if (c.type === "text" && /(^|\n)\s*REFUTE\s*:/i.test(c.text || "")) {
          refuteText = c.text
          return true
        }
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
  return { verified: !!proof, proof: proof || "", decomposeRequested, refuteText, lastVerifyError, lastGoalState }
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
  // Agent-driven disproof of the MASTER (depth 0 only): if the prover flagged the
  // target as false, verify the disproof independently rather than wasting a
  // decomposition on it. A confirmed ¬T sets ctx.refuted for the caller.
  if (res.refuteText && node.depth === 0 && !ctx.signal?.aborted) {
    ctx.emit({ type: "message-annotation", subtype: "status", thought: "🔎 Prover flagged the master as FALSE — verifying the disproof on the daemon…" })
    const dis = await confirmAgentRefute(node.statement, ctx, res.refuteText)
    if (dis.refuted) {
      ctx.refuted = dis
      node.status = "failed"
      return false
    }
    ctx.emit({ type: "message-annotation", subtype: "error", thought: "The claimed counterexample did not verify — continuing." })
  }
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
async function proveHaveFlat(theorem, ctx, { seed } = {}) {
  const budget = ctx.haveTurnBudget || 24
  const maxRetry = Number.isFinite(ctx.maxRedecompose) ? ctx.maxRedecompose : 1
  // When the have-tree banked some holes, it hands us the partially-filled
  // skeleton here so that proven work is never thrown away — the agent only has
  // to finish the remaining `sorry`s. This is a soft HINT (the agent may still
  // restructure); the independent verify gate below is unchanged, so soundness
  // is identical to a from-scratch run.
  const seedNote = seed
    ? `A PARTIAL PROOF is already on the board. In the skeleton below, every \`have\` step whose body is NOT \`sorry\` is ALREADY PROVEN and correct — reuse it verbatim, do NOT redo it. Your ONLY job is to fill the remaining \`sorry\` hole(s) and output the complete, sorry-free proof of the master:\n\`\`\`lean\n${seed}\n\`\`\`\n`
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
            ? `🧩 Finishing the remaining hole(s) in one context — the already-proven steps are kept (${budget} turns).`
            : `🧩 Proving in one context via local \`have\` decomposition (${budget} turns).`,
    })
    const gate = makeProofGate(theorem)
    const verifyIds = new Set()
    let lastVerifyError = ""
    let refuteText = ""
    const onObject = (o) => {
      const ev = gate.observe(o)
      if (ev?.verified) return true
      if (o.type === "assistant" && o.message?.content) {
        for (const c of o.message.content) {
          if (c.type === "tool_use" && c.id && String(c.name || "").endsWith("verify_full_script")) verifyIds.add(c.id)
          if (c.type === "text" && /(^|\n)\s*REFUTE\s*:/i.test(c.text || "")) {
            refuteText = c.text
            return true // the agent believes it's false — stop and verify the disproof
          }
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
        prompt: haveProvePrompt(theorem, ctx.mcpServers, `${seedNote}${extra}\n${REFUTE_NOTE}`),
        mcpServers: ctx.mcpServers,
        model: ctx.model,
        // Under a wall-clock budget, TIME governs — lift the turn cap high so the
        // finisher isn't cut off mid-proof by turns (which is what stranded the
        // near-complete lucas_nresidue_prime run one line from done).
        maxTurns: ctx.computeGoverned ? Math.max(budget, 600) : budget,
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
    // Agent-driven disproof: it flagged the theorem as false. Verify independently.
    if (refuteText && !ctx.signal?.aborted) {
      ctx.emit({ type: "message-annotation", subtype: "status", thought: "🔎 Agent flagged the theorem as FALSE — verifying the disproof on the daemon…" })
      const dis = await confirmAgentRefute(theorem, ctx, refuteText)
      if (dis.refuted) return { verified: false, refuted: true, counterexample: dis.counterexample, disproof: dis.script }
      ctx.emit({ type: "message-annotation", subtype: "error", thought: "The claimed counterexample did not verify — continuing to prove." })
    }
    if (attempt >= maxRetry || ctx.signal?.aborted || deadlinePassed(ctx)) return { verified: false, proof: "" }
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

TWO OUTCOMES — pick the cheaper one:
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
  return `You are a MINION filling ONE hole in an already-verified Lean 4 proof skeleton. Do NOT touch any other hole.

${toolSection}

THE SKELETON (already compiles with every \`have\` stubbed as \`sorry\`):
\`\`\`lean
${skeleton}
\`\`\`

YOUR HOLE: the \`have\` tagged \`--⟪${id}⟫\`. Its declared type is your GOAL; the hypotheses in scope are the theorem's binders plus the EARLIER \`have\`s (they're available by name). To see the EXACT goal state, \`init_proof\` your hole's proposition (closed: ∀-quantify any free variable) and step it with \`apply_tactic\` — lead with strong automation (\`decide\`, \`native_decide\`, \`omega\`, \`simp_all\`, \`nlinarith\`, \`induction\`).

METHOD:
1. Work out the tactics that close ONLY hole \`--⟪${id}⟫\`.
2. CHECK them in context: take the skeleton above, replace ONLY \`sorry --⟪${id}⟫\` with your tactics (leave every other \`sorry --⟪…⟫\` untouched), and verify_full_script. Success = it compiles with only the OTHER holes' \`sorry\` warnings and NO errors. Iterate until that holds.
(You do NOT need to call cleanup_memory — the system frees proof state between holes for you. Spend your turns proving.)

OUTPUT (exactly this shape, nothing else after it):
FILL ⟪${id}⟫
\`\`\`lean
<only the tactics that replace \`sorry\`, one per line, starting at the LEFT margin — no \`have\`, no leading \`by\`, no theorem>
\`\`\`

${SEARCH_USAGE_NOTE}
${extra ? `\n${extra}\n` : ""}`
}

// Fill one hole in an isolated minion (fresh process → bounded context). Returns
// the tactic text, or null if the minion couldn't produce a usable fill.
async function fillHole(skeleton, id, ctx) {
  if (ctx.signal?.aborted) return null
  ctx.emit({ type: "message-annotation", subtype: "status", thought: `🧩 Minion filling hole ⟪${id}⟫ in an isolated context…` })
  const res = await spawnProverStream(
    {
      prompt: haveHoleFillPrompt(skeleton, id, ctx.mcpServers, ""),
      mcpServers: ctx.mcpServers,
      model: ctx.model,
      maxTurns: ctx.turnBudget,
      timeoutMs: ctx.nodeTimeoutMs,
      getDeadline: ctx.getDeadline,
      stage: `⟪${id}⟫`,
      metrics: ctx.metrics,
      signal: ctx.signal,
      searchBudget: ctx.searchBudget,
    },
    { onObject: () => false, emit: ctx.emit },
  )
  const fill = parseFillBlock(res.finalText, id)
  if (!fill) {
    ctx.emit({ type: "message-annotation", subtype: "error", thought: `⚠️ Hole ⟪${id}⟫ minion returned no usable FILL block.` })
    return null
  }
  return fill
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
      maxTurns: ctx.decomposeTurnBudget,
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

  // ---- 2) MINIONS: fill each hole in its OWN isolated context, SEQUENTIALLY ----
  // Sequential, not parallel: Leak II's cleanup_memory is GLOBAL, so concurrent
  // minions clobber each other's proof states. The bridge frees state BETWEEN
  // minions instead (the minion prompt no longer calls cleanup_memory), so each
  // minion still gets a clean daemon without racing the others.
  const pantoUrl = resolvePantographUrl(ctx.mcpServers)
  const fills = new Array(holeIds.length).fill(null)
  for (let i = 0; i < holeIds.length; i++) {
    if (ctx.signal?.aborted) break
    fills[i] = await fillHole(skeleton, holeIds[i], ctx)
    if (pantoUrl)
      await callRemoteMcpTool(pantoUrl, /cleanup.*memory|cleanup_memory/i, {}, { timeoutMs: 15000 }).catch(() => {})
  }

  // ---- 3) SPLICE the holes that DID fill — bank partial progress ---------------
  // A failed hole no longer discards the successful ones: we splice every fill we
  // got and hand the PARTIALLY-filled skeleton onward, so proven work is kept.
  let partial = skeleton
  const remaining = []
  holeIds.forEach((id, i) => {
    if (fills[i] != null) partial = spliceHole(partial, id, fills[i])
    else remaining.push(id)
  })
  const filled = holeIds.length - remaining.length

  if (remaining.length === 0 && !ctx.signal?.aborted) {
    // Every hole filled — assemble + verify hole-free (the full win).
    ctx.emit({ type: "message-annotation", subtype: "status", thought: "🛡️ All holes filled — assembling and re-verifying the whole proof on the daemon…" })
    const v = await verifyViaDaemon(partial, ctx.verifyUrl, { timeoutMs: ctx.verifyTimeoutMs })
    if (v.ok && isHoleFreeProof(parseVerifyOutput(v.text)) && scriptProvesTarget(partial, sig)) {
      ctx.emit({ type: "message-annotation", subtype: "status", thought: `✅ Have-tree assembled a verified proof from ${holeIds.length} isolated holes.` })
      return { verified: true, proof: partial }
    }
    ctx.emit({ type: "message-annotation", subtype: "error", thought: `↩︎ Stitched proof didn't verify (${oneLine(v.text || v.error || "unknown")}) — finishing from the filled skeleton in one context.` })
  } else if (!ctx.signal?.aborted) {
    ctx.emit({ type: "message-annotation", subtype: "status", thought: `🌿 Banked ${filled}/${holeIds.length} hole(s) in isolation; finishing ${remaining.map((h) => `⟪${h}⟫`).join(" ")} in one context.` })
  }

  // ---- 4) FINISH: hand the PARTIALLY-filled skeleton to flat mode as a seed, so
  // the proven holes are never thrown away. Flat mode's gate still requires a
  // full, independently-verified proof of the master, so soundness is unchanged.
  if (ctx.signal?.aborted) return { verified: false, proof: "" }
  return proveHaveFlat(theorem, ctx, { seed: partial })
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
  const metrics = { tools_invoked: 0, llm_invocations: 0, time_elapsed: 0 }
  const emit = (obj) => {
    metrics.time_elapsed = Math.round((Date.now() - start) / 1000)
    send({ ...obj, metrics })
  }

  const strategy = STRATEGIES[opts.strategy] ? opts.strategy : "hacker"
  const style = styleOf(strategy)
  // Admin debug log: the exact prompt(s) the agent(s) receive.
  send({
    type: "prompt",
    prompt:
      style === "have"
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
  if (!verifyUrl) {
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
  const { runId, st: runState } = registerRun(budgetMs)
  // Tell the client its runId + current deadline so it can render the limit
  // indicator and target /extend. Only meaningful when a budget was requested.
  if (budgetMs > 0) send({ type: "run", runId, deadlineMs: runState.deadlineMs, budgetMs: runState.budgetMs })

  const abort = new AbortController()
  const ctx = {
    mcpServers,
    model: opts.model,
    strategy,
    searchBudget: searchBudgetFor(strategy),
    verifyUrl,
    emit,
    metrics,
    signal: abort.signal,
    // Live wall-clock budget: subprocess killers poll this, so /extend rescues
    // even the running stage. computeGoverned lifts turn caps so TIME governs.
    getDeadline: () => runState.deadlineMs,
    computeGoverned: budgetMs > 0,
    turnBudget: clampNum(opts.turnBudget, 1, 40, 10),
    decomposeTurnBudget: clampNum(opts.decomposeTurnBudget, 1, 40, 12),
    maxDepth: clampNum(opts.maxDepth, 1, 6, 3),
    maxNodes: clampNum(opts.maxNodes, 1, 64, 24),
    // #5: how many times a node may re-decompose (with a DIFFERENT split) after
    // a child lemma or the assembly fails, before the node itself fails.
    maxRedecompose: clampNum(opts.maxRedecompose, 0, 5, 1),
    // `have` style only: turn budget for the single flat agent (it does the whole
    // proof in one context, so it gets a larger allowance than a tree node).
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
      // Fast disproof pre-check: a FALSE master is dead on arrival — refute it in
      // seconds (machine-checked ¬T) instead of grinding the prover for minutes.
      if (opts.refuteCheck !== false) {
        emit({ type: "message-annotation", subtype: "status", thought: "🔎 Disproof pre-check — probing small counterexamples…" })
        const pre = await refutePreCheck(theorem, ctx)
        if (pre.refuted) {
          const w = pre.witness
          const cex = w != null ? `counterexample at the first argument = ${w}` : "a small counterexample"
          emit({ type: "message-annotation", subtype: "error", thought: `↯ Master theorem is FALSE — ${cex}. Machine-checked disproof; skipping the prover.` })
          send({ type: "text-delta", content: `↯ **Refuted** — the theorem is false (${cex}), verified by Lean:\n\n\`\`\`lean\n${pre.script}\n\`\`\`` })
          send({ type: "done", metrics, verified: false, refuted: true, counterexample: cex, proof: "", disproof: pre.script })
          res.end()
          return
        }
      }
      let ok = false
      let proof = ""
      if (style === "have" || style === "have-tree") {
        // `have`: one agent, whole proof in one context. `have-tree`: planner +
        // isolated per-hole minions (linear context), falling back to `have`.
        const r = style === "have-tree" ? await proveHaveTree(theorem, ctx) : await proveHaveFlat(theorem, ctx)
        ok = r.verified
        proof = r.proof
        if (r.refuted) {
          emit({ type: "message-annotation", subtype: "error", thought: `↯ Master theorem is FALSE — ${r.counterexample}. Machine-checked disproof.` })
          send({ type: "text-delta", content: `↯ **Refuted** — the theorem is false (${r.counterexample}), verified by Lean.` })
          send({ type: "done", metrics, verified: false, refuted: true, counterexample: r.counterexample, proof: "", disproof: r.disproof })
          res.end()
          return
        }
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
        if (!ok && ctx.refuted) {
          emit({ type: "message-annotation", subtype: "error", thought: `↯ Master theorem is FALSE — ${ctx.refuted.counterexample}. Machine-checked disproof.` })
          send({ type: "text-delta", content: `↯ **Refuted** — the theorem is false (${ctx.refuted.counterexample}), verified by Lean.` })
          send({ type: "done", metrics, verified: false, refuted: true, counterexample: ctx.refuted.counterexample, proof: "", disproof: ctx.refuted.script })
          res.end()
          return
        }
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

    // Push out a running prove's wall-clock budget (the UI's "+5 min" button).
    // Mutates the live deadline the subprocess killers poll, so it rescues even
    // the stage currently executing. Behind the same token + CORS gate above.
    if (req.method === "POST" && url.pathname === "/extend") {
      const body = JSON.parse((await readBody(req)) || "{}")
      const runId = String(body.runId || "")
      const addMs = clampNum(body.addMs, 60000, 3600000, 300000) // +5 min default, 1–60 min
      const st = ACTIVE_RUNS.get(runId)
      if (!st) return json(res, 404, { error: "run_not_found" })
      // If the run was uncapped, base the fresh deadline on now.
      const base = Number.isFinite(st.deadlineMs) ? st.deadlineMs : Date.now()
      st.deadlineMs = base + addMs
      st.budgetMs = (Number.isFinite(st.budgetMs) ? st.budgetMs : 0) + addMs
      return json(res, 200, { ok: true, runId, deadlineMs: st.deadlineMs, budgetMs: st.budgetMs, addedMs: addMs })
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
    body: JSON.stringify({ workerId: WORKER_ID }),
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
    })
    clearInterval(beat)
    // GUARDRAIL: complete (and charge) ONLY on a daemon-verified proof. runProve
    // now runs the SAME makeProofGate as /prove-stream — out.verified is true
    // only when verify_full_script confirmed a target-matching, sorry-free
    // script. A model that merely claims success (out.finalText) does NOT count.
    if (out.verified && out.proof && out.proof.trim()) {
      await workerComplete(job.id, { proof: out.proof, modelId: WORKER_MODEL || "claude" })
      console.log(`[worker] proved ${job.id} in ${out.durationMs}ms`)
    } else {
      const error = out.timedOut
        ? "prover timed out"
        : out.stderr || "no verified proof produced"
      await workerComplete(job.id, { error, modelId: WORKER_MODEL || "claude" })
      console.log(`[worker] failed ${job.id}: ${error.slice(0, 120)}`)
    }
  } catch (e) {
    clearInterval(beat)
    await workerComplete(job.id, { error: e.message })
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
