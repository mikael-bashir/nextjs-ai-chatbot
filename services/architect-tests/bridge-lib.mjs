/**
 * Extract the architect pipeline's pure functions from claude-bridge.mjs so
 * they can be unit-tested.
 *
 * The bridge is a long-running script with top-level side effects, so it
 * cannot simply be imported. Instead each named top-level declaration is
 * sliced out by locating its start line and taking everything up to the next
 * top-level declaration — reliable here because every top-level declaration in
 * that file begins at column 0 while every body line is indented.
 *
 * Two safety nets, because a silently-wrong extraction would make the whole
 * suite meaningless: the assembled module is syntax-checked before evaluation,
 * and every requested symbol must be defined afterwards. Either failing is a
 * hard error, not a skipped test.
 */
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"

const HERE = dirname(fileURLToPath(import.meta.url))

export const BRIDGE_CANDIDATES = [
  join(HERE, "..", "..", "public", "local-claude-bridge.mjs"),
  join(process.env.HOME || "", "claude-bridge.mjs"),
]

export function bridgePath() {
  for (const p of BRIDGE_CANDIDATES) {
    try {
      readFileSync(p, "utf8")
      return p
    } catch {}
  }
  throw new Error(`claude-bridge.mjs not found; looked in:\n  ${BRIDGE_CANDIDATES.join("\n  ")}`)
}

const TOP_LEVEL = /^(?:export\s+)?(?:async\s+)?(?:function|const|let|var|class)\s+([A-Za-z_$][\w$]*)/

export function extract(names) {
  const src = readFileSync(bridgePath(), "utf8")
  const lines = src.split("\n")

  // Index every top-level declaration: name -> start line, plus the sorted set
  // of start lines so a declaration's extent is [start, nextStart).
  const starts = []
  const at = new Map()
  lines.forEach((ln, i) => {
    const m = TOP_LEVEL.exec(ln)
    if (!m) return
    starts.push(i)
    if (!at.has(m[1])) at.set(m[1], i)
  })

  const missing = names.filter((n) => !at.has(n))
  if (missing.length) throw new Error(`not found as top-level declarations in the bridge: ${missing.join(", ")}`)

  const sliceOf = (n) => {
    const s = at.get(n)
    const e = starts.find((x) => x > s)
    return lines.slice(s, e === undefined ? lines.length : e).join("\n")
  }

  // Pull in helpers the requested functions call. Without this, factoring a
  // shared helper out of a tested function silently produces a module that
  // throws ReferenceError at call time — which is how splitting
  // architectBodyStart out of architectSignatureOf broke this suite. Only
  // architect-namespaced top-level declarations are followed, so the closure
  // stays inside the pipeline instead of dragging in the whole bridge.
  const REF = /\b(architect[A-Za-z0-9_$]*|ARCHITECT_[A-Z0-9_]+)\b/g
  const included = [...names]
  const seen = new Set(names)
  for (let i = 0; i < included.length; i++) {
    const text = sliceOf(included[i])
    for (const m of text.matchAll(REF)) {
      const dep = m[1]
      if (seen.has(dep) || !at.has(dep)) continue
      seen.add(dep)
      included.push(dep)
    }
  }

  // Emit in source order so a `const` helper is never used before it is defined.
  included.sort((a, b) => at.get(a) - at.get(b))
  // The bridge's own node imports, re-supplied for extracted helpers that use
  // them (shortHash → createHash). Unused imports are harmless in ESM.
  const preamble = `import { createHash } from "node:crypto"\n\n`
  return preamble + included.map(sliceOf).join("\n\n") + `\n\nexport { ${names.join(", ")} }\n`
}

export async function loadBridgeSymbols(names) {
  const code = extract(names)
  // Syntax-check before evaluating: a mis-sliced chunk must fail loudly here
  // rather than quietly producing a module with the wrong semantics.
  const mod = await import("data:text/javascript," + encodeURIComponent(code))
  for (const n of names) {
    if (typeof mod[n] === "undefined") throw new Error(`extracted module is missing ${n}`)
  }
  return mod
}
