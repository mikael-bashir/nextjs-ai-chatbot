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

// All theorem/lemma signatures declared in a script (canonical) — for surfacing
// a near-miss when the immutability check rejects a scaffold.
function scriptSignatures(script) {
  const re = /\b(?:theorem|lemma)\b[\s\S]*?(?=:=)/g
  const out = []
  let m
  while ((m = re.exec(script)) !== null) out.push(canonicalSig(m[0]))
  return out
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
function parseVerifyOutput(text) {
  const raw = String(text == null ? "" : text)
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
    decls.push({ kind: starts[i].kind, text, signature: theoremSignature(text) })
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

// Just the target declaration's text from a scaffold (helper stubs dropped —
// children supply the real proofs during assembly).
function targetDeclarationOnly(scaffold, targetSig) {
  for (const d of extractDeclarations(scaffold)) {
    if (d.signature && d.signature === targetSig) return d.text
  }
  return ""
}

// The helper lemmas a scaffold introduced (every theorem/lemma but the target).
function helperDeclarations(scaffold, targetSig) {
  return extractDeclarations(scaffold).filter(
    (d) =>
      (d.kind === "theorem" || d.kind === "lemma") &&
      d.signature &&
      d.signature !== targetSig,
  )
}

// Lean requires a name to be declared BEFORE use, so a scaffold that writes the
// target first (referencing helpers below) fails purely on ordering. Rebuild it
// with helpers first (given order) and the target LAST, so the structural gate
// judges the reduction, not the author's ordering.
function normalizeScaffoldOrder(scaffold, targetSig) {
  const decls = extractDeclarations(stripImports(scaffold))
  const target = decls.find((d) => d.signature && d.signature === targetSig)
  if (!target) return stripImports(scaffold)
  const others = decls.filter((d) => d !== target)
  return [...others.map((d) => d.text), target.text].join("\n\n")
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
    const tgt = targetDeclarationOnly(node.scaffold || "", node.signature)
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

// Compile a script against the verify daemon DIRECTLY over MCP-SSE. The
// orchestrator does not trust the agent's own verify calls for scaffolds/
// assemblies IT constructs — it checks them itself. One-shot SSE session.
function verifyViaDaemon(script, sseUrl, { timeoutMs = 180000 } = {}) {
  return new Promise((resolve) => {
    let base
    try {
      base = new URL(sseUrl)
    } catch {
      resolve({ ok: false, text: "", error: `bad daemon url: ${sseUrl}` })
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
      () => done({ ok: false, text: "", error: `verify timed out after ${timeoutMs}ms` }),
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
        const verify = tools.find((t) => /verify.*full.*script|verify_full_script/i.test(t.name))
        if (!verify) throw new Error("verify_full_script not found on daemon")
        const r = await rpc("tools/call", { name: verify.name, arguments: { script } })
        if (r?.error) throw new Error(`daemon RPC error: ${JSON.stringify(r.error)}`)
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

// The goal is to let Claude use the tools logically on its own — but a bare
// "prove this" makes it fall into an endless moogle/loogle syntax-search spiral
// on hard theorems and never actually build or check a proof. So we hand it an
// explicit, verification-first workflow: draft → verify_full_script → iterate,
// with library search as a *subordinate* step, not the main loop. `extra` lets
// the tree append a node-specific note (e.g. the voluntary-DECOMPOSE option).
function provePrompt(theorem, mcpServers = [], extra = "") {
  const toolSection = mcpToolSection(mcpServers)

  return `You are proving the following Lean 4 theorem.

${toolSection}

You have a full toolkit. Reach for it — don't reason in the abstract when a tool can answer the question for you. Each tool is for a different job:
- verify_full_script — compiles a whole script; it is the SOURCE OF TRUTH. A proof only counts when it reports success on the target theorem with no errors and no \`sorry\`.
- init_proof + apply_tactic — open the goal as a LIVE proof state and advance it ONE tactic at a time, seeing the exact resulting goals, hypotheses and elaborated types after each step (the Lean Infoview, as an API). Lean on these whenever a goal is intricate, a signature is fiddly, or a whole-script attempt fails in a way you don't understand — stepping through interactively shows you what actually works far faster than guessing at a full script.
- get_current_proof_state — dump the script built so far and the remaining goals for a proof state.
- moogle_search — semantic/English search to DISCOVER a lemma name or Mathlib naming convention. loogle_search — exact type/pattern search once you know roughly what you're after.

WORKFLOW:
0. Load the tools (ToolSearch select, as above). Mandatory, first.
1. Write a first candidate proof from the statement below (replace \`sorry\`) and call verify_full_script — do this BEFORE searching; the compiler's real errors teach you the most.
2. Iterate. Read the errors and fix the script; re-run verify_full_script. When a subgoal is intricate or an error is opaque, OPEN it with init_proof/apply_tactic and step through it to see the true goal state, then fold what worked back into the script. Prefer stepping through a hard goal over staring at it.
3. Search when you need a specific lemma: moogle_search first to find a name, then loogle_search to pin the exact signature.
4. If ANY tool errors or hangs, do NOT retry it in a loop — pivot to a different tool or approach and keep moving.
5. A proof is done ONLY when verify_full_script reports success on a script containing the ORIGINAL theorem below — same name and signature — with no \`sorry\`. Verifying helper \`example\`s or side lemmas is fine for exploration but does NOT count. Then output that final verified proof as a single \`\`\`lean code block.

Keep momentum: attempt → verify → when stuck, step through with the interactive tools or look up the lemma → attempt again. Don't spend a long stretch only searching or only thinking; put the goal through the tools.
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
function decomposePrompt(theorem, mcpServers = []) {
  const toolSection = mcpToolSection(mcpServers)
  return `You are DECOMPOSING a Lean 4 theorem you could not close directly. Your job on THIS run is not to finish the proof — it is to break the goal into smaller, independently-provable sub-lemmas, so that separate runs can each close one.

${toolSection}

Produce a single self-contained Lean scaffold with this exact shape:
  1. One or more HELPER LEMMAS. Each has a real, well-typed signature and a body of exactly \`:= by sorry\`. Give them descriptive, unique names (e.g. \`theorem_name_step_mul_comm\`), never generic ones like \`helper\` or \`aux\`.
  2. The ORIGINAL theorem below, VERBATIM — same name, same signature, do NOT change one character of the statement — proved USING the helper lemmas. Its proof must contain NO \`sorry\`: every remaining hole must live inside a helper, not in the main theorem.
  3. Write the helpers ABOVE the theorem (Lean requires a name to be declared before it is used).

The decomposition is correct when compiling the scaffold yields NO errors and the only holes are the helper \`sorry\`s — that proves the main theorem really does follow from the helpers. Use verify_full_script to check this: iterate until there are no ERRORS (deprecation/linter warnings are fine; the helper \`sorry\` warnings are expected). Use init_proof/apply_tactic to discover which intermediate facts the main proof actually needs, so your helper statements are the RIGHT ones. Each helper should be a genuinely smaller step than the original — if a "helper" is just the original theorem restated, you have not decomposed anything.

CRITICAL — the target statement is IMMUTABLE. Your scaffold MUST contain the original theorem with its signature reproduced EXACTLY as given below (same name, binders, and statement up to \`:=\`). If you rename it, drop a hypothesis, restate it inductively, or otherwise change the signature, the decomposition is REJECTED even if it compiles. Copy the line below verbatim and only fill in its proof:

  ${normalizeLean(theorem).replace(/\s*:=\s*by\s+sorry\s*$/i, "")} := by
    <your proof using the helper lemmas>

When the scaffold compiles with no errors, output it as a single \`\`\`lean code block.

Original theorem (immutable — reproduce its signature exactly):
${theorem}`
}

// Non-streaming prove used by the /prove route AND the customer-traffic worker.
// GUARDRAIL: this must NOT trust the model's final prose. Like /prove-stream it
// runs stream-json and feeds every line through the SHARED makeProofGate, so a
// result is only "verified" when the daemon confirmed a target-matching, sorry-
// free script. `verified`/`proof` reflect that gate; `finalText` is the model's
// closing message, kept only for diagnostics. The worker charges on `verified`.
function runProve(theorem, mcpServers, opts = {}) {
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
    const timeoutMs = Math.min(Math.max(Number(opts.timeoutMs) || 1800000, 30000), 3600000)
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
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
function spawnProverStream({ prompt, mcpServers, model, maxTurns, timeoutMs, stage, metrics, signal }, { onObject, emit }) {
  return new Promise((resolve) => {
    let cfgPath
    try {
      const dir = mkdtempSync(join(tmpdir(), "claude-tree-"))
      cfgPath = join(dir, "mcp.json")
      writeFileSync(cfgPath, JSON.stringify(buildMcpConfig(mcpServers)))
    } catch (e) {
      resolve({ ok: false, finalText: "", exitCode: null, timedOut: false, stderr: `mcp config: ${e.message}` })
      return
    }
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
    const cap = clampNum(timeoutMs, 30000, 3600000, 900000)
    let timedOut = false
    let stopped = false
    const kill = () => {
      try {
        child.kill("SIGKILL")
      } catch {
        /* gone */
      }
    }
    const timer = setTimeout(() => {
      timedOut = true
      kill()
    }, cap)
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
      clearTimeout(timer)
      if (signal) signal.removeEventListener?.("abort", onAbort)
      resolve({ ok: false, finalText, exitCode: null, timedOut, stopped, stderr: e.message })
    })
    child.on("close", (code) => {
      clearTimeout(timer)
      if (signal) signal.removeEventListener?.("abort", onAbort)
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
  const extra =
    "EARLY DECOMPOSE (optional): if partway through you judge this goal is too large to close directly and would be better split into sub-lemmas, output a line that is exactly `DECOMPOSE: <one-line reason>` and stop — a dedicated decomposition run will then take over. Only do this when genuinely stuck; prefer to finish the proof if you can."
  const prompt = provePrompt(node.statement, ctx.mcpServers, extra)
  const onObject = (o) => {
    const ev = gate.observe(o)
    if (ev?.verified) return true
    if (o.type === "assistant" && o.message?.content) {
      for (const c of o.message.content) {
        if (c.type === "text" && /(^|\n)\s*DECOMPOSE\s*:/i.test(c.text || "")) {
          decomposeRequested = true
          return true
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
      stage: ctx.stage,
      metrics: ctx.metrics,
      signal: ctx.signal,
    },
    { onObject, emit: ctx.emit },
  )
  const proof = gate.verifiedScript
  return { verified: !!proof, proof: proof || "", decomposeRequested }
}

// Run the Decomposer subagent on a node, then GATE its output ourselves: take
// the scaffolds it compiled (target-preserving, ≥1 helper), reorder helpers-
// first, and verify each on the daemon. Accept the first that is either a full
// (sorry-free) proof or a structurally-valid reduction. Returns
// { ok, fullyProved?, scaffold, children, reason }.
async function runDecomposer(node, ctx) {
  const targetSig = node.signature
  const verifyCalls = {}
  const candidates = []
  const nearMisses = [] // scaffolds with ≥2 decls but no signature-preserving match
  const consider = (script) => {
    if (!script) return
    if (scriptProvesTarget(script, targetSig) && helperDeclarations(script, targetSig).length) {
      candidates.push(script)
    } else {
      const sigs = scriptSignatures(script)
      if (sigs.length >= 2) nearMisses.push(sigs)
    }
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
      prompt: decomposePrompt(node.statement, ctx.mcpServers),
      mcpServers: ctx.mcpServers,
      model: ctx.model,
      maxTurns: ctx.decomposeTurnBudget,
      timeoutMs: ctx.nodeTimeoutMs,
      stage: `${ctx.stage}✂️`,
      metrics: ctx.metrics,
      signal: ctx.signal,
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
  for (const cand of uniq.slice(0, 3)) {
    if (ctx.signal?.aborted) break
    const ordered = normalizeScaffoldOrder(cand, targetSig)
    const v = await verifyViaDaemon(ordered, ctx.verifyUrl, { timeoutMs: ctx.verifyTimeoutMs })
    const parsed = parseVerifyOutput(v.text)
    if (v.ok && isHoleFreeProof(parsed)) {
      ctx.emit({ type: "message-annotation", subtype: "status", thought: `${ctx.stage}✂️ Scaffold compiled with no holes — node fully proved.` })
      return { ok: true, fullyProved: true, scaffold: ordered, children: [], reason: "scaffold compiled sorry-free" }
    }
    if (v.ok && isStructurallyValidDecomposition(parsed)) {
      const helpers = helperDeclarations(ordered, targetSig)
      ctx.emit({ type: "message-annotation", subtype: "status", thought: `${ctx.stage}✂️ Verified reduction → ${helpers.length} sub-lemma(s).` })
      return { ok: true, scaffold: ordered, children: helpers, reason: `reduces to ${helpers.length} lemma(s)` }
    }
  }
  if (!uniq.length && nearMisses.length) {
    // The decomposer built a scaffold but no declaration reproduced the target
    // signature. Surface the closest miss so the mismatch is visible (usually a
    // restated statement or a changed binder) rather than an opaque failure.
    const produced = nearMisses[nearMisses.length - 1].filter((s) => s !== targetSig)
    ctx.emit({
      type: "message-annotation",
      subtype: "error",
      thought: `${ctx.stage}✂️ Scaffold did not reproduce the target signature.\n  target:   ${oneLine(targetSig)}\n  produced: ${produced.map(oneLine).join("\n            ")}`,
    })
  }
  return {
    ok: false,
    reason: uniq.length
      ? "no candidate reduced the goal cleanly (a real type error remained)"
      : nearMisses.length
        ? "decomposer changed the target signature (see the near-miss above) — it must reproduce it verbatim"
        : "decomposer produced no scaffold containing the target theorem",
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

  // 2. Decompose (forced after the turn budget, or voluntarily requested).
  ctx.emit({
    type: "message-annotation",
    subtype: "status",
    thought: res.decomposeRequested
      ? `🪓 Agent requested decomposition of ${declName(node.signature)}.`
      : `🪓 Not closed in ${ctx.turnBudget} turns — forcing decomposition of ${declName(node.signature)}.`,
  })
  const dec = await runDecomposer(node, ctx)
  if (!dec.ok) {
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
  ctx.emit({
    type: "message-annotation",
    subtype: "status",
    thought: `➗ Split ${declName(node.signature)} into ${node.children.length} lemma(s): ${node.children.map((c) => declName(c.signature)).join(", ")}`,
  })

  // 3. Recurse into every child; a single unproved child fails the node.
  for (const child of node.children) {
    const ok = await proveNode(child, ctx)
    if (!ok) {
      node.status = "failed"
      ctx.emit({ type: "message-annotation", subtype: "error", thought: `❌ Sub-lemma ${declName(child.signature)} could not be proved — ${declName(node.signature)} fails.` })
      return false
    }
  }

  // 4. Assemble the whole subtree and gate on ONE final HOLE-FREE compile (no
  // errors, no sorry) that contains the immutable node signature. Benign
  // warnings (deprecations/linters) are tolerated — they are not holes.
  if (ctx.signal?.aborted) return false
  const assembled = assembleScript(node)
  ctx.emit({ type: "message-annotation", subtype: "status", thought: `🧩 Assembling ${declName(node.signature)} from ${node.children.length} proved lemma(s) — final verify…` })
  const v = await verifyViaDaemon(assembled, ctx.verifyUrl, { timeoutMs: ctx.verifyTimeoutMs })
  const parsed = parseVerifyOutput(v.text)
  if (v.ok && isHoleFreeProof(parsed) && scriptProvesTarget(assembled, node.signature)) {
    node.proof = assembled
    node.status = "proved-assembled"
    ctx.emit({ type: "message-annotation", subtype: "status", thought: `🧩 ${declName(node.signature)} assembled and verified sorry-free.` })
    return true
  }
  node.status = "failed"
  ctx.emit({
    type: "message-annotation",
    subtype: "error",
    thought: `❌ Assembly of ${declName(node.signature)} did not verify: ${oneLine(v.text || v.error || "unknown")}`,
  })
  return false
}

// SSE entrypoint for the decomposition orchestrator. Emits the SAME frame shapes
// as proveStream (prompt / message-annotation / thinking / text-delta / done),
// so the existing client + ProverConsole render it with no changes.
function proveTreeStream(res, theorem, mcpServers, opts = {}) {
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

  // Admin debug log: the exact prompts both subagent roles receive.
  send({
    type: "prompt",
    prompt:
      "[DECOMPOSITION MODE — proof tree]\n\n=== NODE-PROVER PROMPT ===\n" +
      provePrompt(theorem, mcpServers, "(+ optional early-DECOMPOSE handoff)") +
      "\n\n=== DECOMPOSER PROMPT ===\n" +
      decomposePrompt(theorem, mcpServers),
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

  const verifyUrl = resolveVerifyUrl(mcpServers)
  if (!verifyUrl) {
    emit({ type: "error", message: "No verify_full_script MCP server is connected — decomposition needs one to gate scaffolds." })
    send({ type: "done", metrics, verified: false, proof: "" })
    res.end()
    return
  }

  const abort = new AbortController()
  const ctx = {
    mcpServers,
    model: opts.model,
    verifyUrl,
    emit,
    metrics,
    signal: abort.signal,
    turnBudget: clampNum(opts.turnBudget, 1, 40, 10),
    decomposeTurnBudget: clampNum(opts.decomposeTurnBudget, 1, 40, 12),
    maxDepth: clampNum(opts.maxDepth, 1, 6, 3),
    maxNodes: clampNum(opts.maxNodes, 1, 64, 24),
    nodeTimeoutMs: clampNum(opts.nodeTimeoutMs, 30000, 3600000, 900000),
    verifyTimeoutMs: 180000,
    nodeCount: 0,
    stage: "",
  }
  res.on("close", () => {
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
      emit({ type: "message-annotation", subtype: "status", thought: `🌲 Decomposition mode: prove-or-split, ${ctx.turnBudget} turns/node, depth ≤ ${ctx.maxDepth}.` })
      const ok = await proveNode(root, ctx)
      const proof = ok ? root.proof : ""
      if (ok && proof) {
        emit({ type: "message-annotation", subtype: "status", thought: "✅ System check passed — full tree assembled and verified sorry-free." })
        send({ type: "text-delta", content: `✅ **Verified proof** (decomposition tree, confirmed by verify_full_script):\n\n\`\`\`lean\n${proof}\n\`\`\`` })
      } else {
        emit({ type: "message-annotation", subtype: "error", thought: "❌ System check failed — the tree did not close every leaf." })
        send({ type: "text-delta", content: "⚠️ Not accepted — the decomposition tree did not produce a verified, sorry-free proof of the target." })
      }
      send({ type: "done", metrics, verified: !!(ok && proof), proof })
    } catch (e) {
      emit({ type: "error", message: `tree error: ${String(e?.message || e)}` })
      send({ type: "done", metrics, verified: false, proof: "" })
    } finally {
      res.end()
    }
  })()
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
