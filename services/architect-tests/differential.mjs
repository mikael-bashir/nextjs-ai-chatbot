#!/usr/bin/env node
/**
 * Differential fuzz test: the Python declaration splitter
 * (blueprint.py :: parse_decl) and the JS one
 * (claude-bridge.mjs :: architectSignatureOf) must agree on where a
 * declaration's proof body begins.
 *
 * Why this exists. Every parser defect found in this stack so far has been the
 * SAME defect written twice in two languages — first "split at the first
 * top-level `:=`" (which the `let` binders in `enclosing_circle_radius` broke),
 * then the bridge's `:=\s*by` regex, then string literals in both. Hand-written
 * cases only cover the mistakes I already thought of. Generating declarations
 * from the grammar fragments that have historically caused trouble, and
 * comparing the two implementations against each other, covers the ones I
 * did not.
 *
 * Deterministic: seeded PRNG, so a failure is reproducible from its case id.
 *
 * Run:  node services/architect-tests/differential.mjs [count] [seed]
 */
import { writeFileSync, mkdtempSync } from "node:fs"
import { execFileSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"
import { tmpdir } from "node:os"
import { loadBridgeSymbols } from "./bridge-lib.mjs"

const HERE = dirname(fileURLToPath(import.meta.url))
const COUNT = Number(process.argv[2] || 3000)
const SEED = Number(process.argv[3] || 20260727)

const { architectSignatureOf } = await loadBridgeSymbols(["architectSignatureOf"])

// xorshift32 — small, deterministic, dependency-free.
let s = SEED >>> 0
const rnd = () => {
  s ^= s << 13; s >>>= 0
  s ^= s >>> 17
  s ^= s << 5; s >>>= 0
  return s / 0x100000000
}
const pick = (xs) => xs[Math.floor(rnd() * xs.length)]
const maybe = (p = 0.5) => rnd() < p

// Fragments chosen for the hazards they encode, not for realism: each one is
// something that has broken, or could break, a naive scanner.
const BINDERS = [
  "let a : Nat := 1",
  "let b := 2",
  "let ⟨p, q⟩ := (1, 2)",
  "let s := \"x := y\"",
  "let f : Nat → Nat := id",
  "have h : Nat := 3",
  "have h2 := 4",
  "let c : ℚ := -1/6",
  "let d : Nat := id (a := 1)",
]
const ATOMS = [
  "1 = 1",
  "a = 1",
  "(let y := 2; y) = 2",
  "({ fst := 1, snd := 2 } : Nat × Nat).1 = 1",
  "\"a := b\".length = 6",
  "\"-- not a comment\".length = 17",
  "deleted = complete",
  "letter = havoc",
  "(⟨1, 2⟩ : Nat × Nat).1 = 1",
  "∀ n : ℕ, n = n",
  "(n : ℕ) → n = n",
  "P → P",
]
const HEAD_BINDERS = ["", " (h : Nat := 3)", " {α : Type}", " [inst : Inhabited α]", " (n : ℕ)"]
const BODIES = ["by sorry_using []", "by simp", "rfl", "fun h => h", "sorry", "by\n  let z := 1\n  rfl", "by\n  have hh : Nat := 2\n  rfl"]
const NOISE = ["", " -- x := y", " /- q := r -/", " /- let w := 1 -/", " /- a /- b -/ c -/"]

function gen(i) {
  const kw = maybe(0.2) ? "lemma" : "theorem"
  const head = pick(HEAD_BINDERS)
  const nb = Math.floor(rnd() * 4)
  const binders = []
  for (let k = 0; k < nb; k++) binders.push(pick(BINDERS))
  const sep = maybe() ? "\n    " : "; "
  const stmt = (binders.length ? binders.join(sep) + sep : "") + pick(ATOMS) + pick(NOISE)
  const body = maybe(0.9) ? ` := ${pick(BODIES)}` : ""
  return { id: `fuzz-${i}`, lean: `${kw} t_${i}${head} :${maybe() ? "\n    " : " "}${stmt}${body}` }
}

const cases = Array.from({ length: COUNT }, (_, i) => gen(i))

// One Python invocation for the whole batch.
const dir = mkdtempSync(join(tmpdir(), "arch-diff-"))
const inPath = join(dir, "cases.json")
writeFileSync(inPath, JSON.stringify(cases))

const PY = `
import json, os, sys
sys.path.insert(0, ${JSON.stringify(join(HERE, "..", "hf-spaces", "leak-xii", "shared"))})
import blueprint as bp
cases = json.load(open(${JSON.stringify(inPath)}, encoding="utf-8"))
out = {}
for c in cases:
    chunks, spans = bp.split_decls(c["lean"])
    nodes = [n for n in (bp.parse_decl(ch, sp) for ch, sp in zip(chunks, spans)) if n]
    out[c["id"]] = bp.normalize_sig(nodes[0].signature) if nodes else None
print(json.dumps(out))
`
const pyOut = JSON.parse(execFileSync("python3", ["-c", PY], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }))

// Mirror of blueprint.normalize_sig so the two sides are compared on equal terms.
const normalize = (sig) => String(sig || "").replace(/\s+/g, " ").trim().replace(/^lemma\b/, "theorem")

let mismatches = 0
let nulls = 0
for (const c of cases) {
  const py = pyOut[c.id]
  if (py === null) {
    nulls++
    console.log(`FAIL ${c.id}: python parsed nothing\n   lean: ${JSON.stringify(c.lean)}`)
    continue
  }
  const js = normalize(architectSignatureOf(c.lean))
  if (py !== js) {
    mismatches++
    if (mismatches <= 15) {
      console.log(`FAIL ${c.id}\n   lean  : ${JSON.stringify(c.lean)}\n   python: ${JSON.stringify(py)}\n   js    : ${JSON.stringify(js)}`)
    }
  }
}

console.log(
  `\ndifferential: ${cases.length} generated declarations, seed ${SEED} — ` +
    `${mismatches} mismatch(es), ${nulls} unparsed`,
)
if (mismatches > 15) console.log(`(${mismatches - 15} further mismatches suppressed)`)
process.exit(mismatches || nulls ? 1 : 0)
