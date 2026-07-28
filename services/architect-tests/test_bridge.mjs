#!/usr/bin/env node
/**
 * Parser + policy tests for the architect pipeline's pure functions in
 * claude-bridge.mjs.
 *
 * Run:  node services/architect-tests/test_bridge.mjs
 * Exit 0 = all green.
 */
import { readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"
import { loadBridgeSymbols, bridgePath } from "./bridge-lib.mjs"

const HERE = dirname(fileURLToPath(import.meta.url))
const CORPUS = JSON.parse(readFileSync(join(HERE, "corpus.json"), "utf8")).cases

// Point the proof bank at a throwaway file BEFORE the module is evaluated —
// PROOF_BANK_PATH is read from the environment at import time.
const BANK_TMP = join(tmpdir(), `leak-proof-bank-test-${process.pid}.json`)
process.env.LEAK_PROOF_BANK = BANK_TMP

const M = await loadBridgeSymbols([
  "ARCHITECT_RESOURCE_RE",
  "architectIsResourceFailure",
  "ARCHITECT_MAX_REC_DEPTH",
  "ARCHITECT_MAX_HEARTBEATS",
  "architectPrelude",
  "architectSignatureOf",
  "architectNegSignature",
  "architectNodePrefix",
  "ARCHITECT_CLASSES",
  "ARCHITECT_DIAGNOSE_CLASSES",
  "architectSplitSig",
  "architectStripVerdicts",
  "architectAnnotate",
  "architectAssemble",
  "architectProofBody",
  "architectAssemblyDefects",
  "makeAgentTrace",
  "traceSubmission",
  "shortHash",
  "normaliseLean",
  "diffLines",
  "ARCHITECT_CONSULT_STREAK",
  "ARCHITECT_CONSULT_MAX",
  "PROOF_BANK_PATH",
  "proofBankRead",
  "proofBankWrite",
  "proofBankKey",
  "proofBankStore",
  "proofBankFind",
])

const fails = []
const eq = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  if (!ok) fails.push(label)
  console.log(`${ok ? "PASS" : "FAIL"} ${label}${ok ? "" : `\n   got  ${JSON.stringify(got)}\n   want ${JSON.stringify(want)}`}`)
}
const ok = (label, cond, detail = "") => {
  if (!cond) fails.push(label)
  console.log(`${cond ? "PASS" : "FAIL"} ${label}${cond ? "" : detail ? ` — ${detail}` : ""}`)
}

console.log(`bridge under test: ${bridgePath()}\n`)

// The bridge exists twice: `public/local-claude-bridge.mjs` (shipped to
// operators as a download) and `~/claude-bridge.mjs` (what actually runs).
// Editing one and testing the other is a real trap — it happened while writing
// this suite, and the corpus caught it as four phantom parser failures. Fail
// loudly on drift instead of testing a file nobody runs.
{
  const repo = join(HERE, "..", "..", "public", "local-claude-bridge.mjs")
  const home = join(process.env.HOME || "", "claude-bridge.mjs")
  let a = null
  let b = null
  try { a = readFileSync(repo, "utf8") } catch {}
  try { b = readFileSync(home, "utf8") } catch {}
  if (a !== null && b !== null && a !== b) {
    console.log("FAIL bridge copies have drifted")
    console.log(`   ${repo}  (${a.length} bytes)`)
    console.log(`   ${home}  (${b.length} bytes)`)
    console.log("   -> sync them before trusting this run:  cp ~/claude-bridge.mjs public/local-claude-bridge.mjs\n")
    process.exit(1)
  }
}

// ---------------------------------------------------------------------------
console.log("== shared corpus: signature extraction ==")
// ---------------------------------------------------------------------------
for (const c of CORPUS) eq(`corpus/${c.id}`, M.architectSignatureOf(c.lean), c.sig.trim())

// Prefix handling is JS-only (the Python splitter starts at the decl keyword).
eq(
  "prefix/set_option preserved",
  M.architectSignatureOf("set_option maxRecDepth 9 in\ntheorem t : P := by simp"),
  "set_option maxRecDepth 9 in\ntheorem t : P",
)
eq("prefix/no decl keyword is passed through", M.architectSignatureOf("garbage"), "garbage")
eq("empty input", M.architectSignatureOf(""), "")
eq("null input", M.architectSignatureOf(null), "")

// ---------------------------------------------------------------------------
console.log("\n== shared corpus: body extraction (the OTHER half of the cut) ==")
// ---------------------------------------------------------------------------
// The signature and the body are two halves of one cut, and for a long time
// only the signature half used the real scanner -- the body half was a bare
// `indexOf(":=")`. Nothing caught it, because nothing tested the body half in
// JS. The corpus already carries the expected body for the Python splitter, so
// hold JS to the identical expectation.
for (const c of CORPUS) eq(`corpus-body/${c.id}`, M.architectProofBody(c.lean), c.body === null ? "" : c.body.trim())

// The live failure, end to end: a target whose statement opens with `let`.
{
  const rebuilt = [
    "theorem enclosing_circle_radius :",
    "    let k1 : ℚ := 1",
    "    let k2 : ℚ := 1/2",
    "    let k3 : ℚ := 1/3",
    "    let R : ℚ := 6",
    "    let k4 : ℚ := -1/R",
    "    (k1 + k2 + k3 + k4)^2 = 2*(k1^2 + k2^2 + k3^2 + k4^2) := by",
    "  norm_num",
  ].join("\n")
  const sig = rebuilt.slice(0, rebuilt.lastIndexOf(" :="))
  eq("enclosing_circle_radius: scanner cut (no signature given)", M.architectProofBody(rebuilt), "by\n  norm_num")
  eq("enclosing_circle_radius: exact cut against the sent signature", M.architectProofBody(rebuilt, sig), "by\n  norm_num")
  ok(
    "enclosing_circle_radius: signature survives the cut whole",
    M.architectSignatureOf(rebuilt).endsWith("2*(k1^2 + k2^2 + k3^2 + k4^2)"),
    M.architectSignatureOf(rebuilt),
  )
  // The exact cut is what actually protects the certified file: it does not
  // parse, so it cannot be fooled by anything inside the statement.
  eq(
    "exact cut is used in preference to the scanner",
    M.architectProofBody("theorem t :\n    let a : Nat := 1\n    a = 1 :=\n  by simp", "theorem t :\n    let a : Nat := 1\n    a = 1"),
    "by simp",
  )
  eq("exact cut falls back to the scanner when the signature is not a prefix", M.architectProofBody("theorem t : True := trivial", "theorem OTHER : True"), "trivial")
}

// ---------------------------------------------------------------------------
console.log("\n== architectAssemblyDefects (harness-fault guard) ==")
// ---------------------------------------------------------------------------
{
  const letSig =
    "theorem t :\n    let k1 : ℚ := 1\n    let k2 : ℚ := 1/2\n    (k1 + k2)^2 = 2*(k1^2 + k2^2)"
  const g = [
    { name: "d", kind: "def", signature: "def d : Nat", declTextNoAttr: "def d : Nat := 7" },
    { name: "t", kind: "theorem", signature: letSig },
  ]
  eq("clean assembly reports no defects", M.architectAssemblyDefects(g, new Map([["t", "by norm_num"]])), [])
  ok("a missing body is caught", M.architectAssemblyDefects(g, new Map()).length === 1)
  ok("an empty body is caught", M.architectAssemblyDefects(g, new Map([["t", "   \n "]])).length === 1)
  // The signature the ORIGINAL bug produced: cut short at the first `let`, so
  // the appended `:=` gets eaten by that binder and the read-back runs on into
  // the body. This is the shape the check exists for.
  ok(
    "a signature truncated at a let binder is caught",
    M.architectAssemblyDefects(
      [{ name: "t", kind: "theorem", signature: "theorem t :\n    let k1 : ℚ" }],
      new Map([["t", "by norm_num"]]),
    ).length === 1,
  )
  ok("definitions are not subject to the check", M.architectAssemblyDefects([g[0]], new Map()).length === 0)
  // Honest about the limit: a split-based mangling round-trips through this
  // check, which is exactly why architectProofBody cuts against the known
  // signature rather than relying on a parse being right.
  ok(
    "known limit: a split-based mangling round-trips past this backstop",
    M.architectAssemblyDefects(g, new Map([["t", "1\n    let k2 : ℚ := 1/2\n    (k1 + k2)^2 = 2*(k1^2 + k2^2) := by norm_num"]])).length === 0,
  )
}

// ---------------------------------------------------------------------------
console.log("\n== architectSplitSig (drives the refutation gate) ==")
// ---------------------------------------------------------------------------
eq("closed statement", M.architectSplitSig("theorem twelve : 12 = 4 * 9"), {
  name: "twelve",
  binders: "",
  concl: "12 = 4 * 9",
})
eq("binders detected -> no refutation attempted", M.architectSplitSig("theorem tp (k : ℕ) : 12^k = 4^k"), {
  name: "tp",
  binders: "(k : ℕ)",
  concl: "12^k = 4^k",
})
eq("colon inside a binder does not split", M.architectSplitSig("lemma f {p n : ℕ} (hp : p.Prime) : multiplicity p 1 = 0"), {
  name: "f",
  binders: "{p n : ℕ} (hp : p.Prime)",
  concl: "multiplicity p 1 = 0",
})
eq("let-statement is closed, conclusion is the whole let-chain", M.architectSplitSig("theorem t : let a : Nat := 3\n  a = 3"), {
  name: "t",
  binders: "",
  concl: "let a : Nat := 3\n  a = 3",
})
eq("junk rejected", M.architectSplitSig("not a signature"), null)
eq("signature with no colon rejected", M.architectSplitSig("theorem t"), null)

// ---------------------------------------------------------------------------
console.log("\n== architectNegSignature ==")
// ---------------------------------------------------------------------------
eq("closed negation", M.architectNegSignature("theorem t : 1 = 2"), "theorem t_neg : ¬ (1 = 2)")
eq(
  "binders become a forall",
  M.architectNegSignature("theorem t (n : ℕ) : n = 0"),
  "theorem t_neg : ¬ (∀ (n : ℕ), n = 0)",
)
eq("junk yields null", M.architectNegSignature("nonsense"), null)

// ---------------------------------------------------------------------------
console.log("\n== resource vs reasoning failure ==")
// ---------------------------------------------------------------------------
ok("maxRecDepth text", M.architectIsResourceFailure({}, "maximum recursion depth has been reached"))
ok("heartbeats text", M.architectIsResourceFailure({}, "maximum number of heartbeats (200000) has been reached"))
ok("XII structured flag", M.architectIsResourceFailure({ resourceLimit: true }, "x"))
ok("backend error", M.architectIsResourceFailure({}, "Compile backend error: boom"))
ok("a solve is never a resource failure", !M.architectIsResourceFailure({ solve: true }, "maximum recursion depth"))
ok("unknown constant is a reasoning failure", !M.architectIsResourceFailure({}, "unknown constant `Foo.bar`"))
ok("plain type mismatch is a reasoning failure", !M.architectIsResourceFailure({}, "type mismatch"))

// ---------------------------------------------------------------------------
console.log("\n== architectPrelude (resource floor) ==")
// ---------------------------------------------------------------------------
const D = M.ARCHITECT_MAX_REC_DEPTH
const H = M.ARCHITECT_MAX_HEARTBEATS
eq("floor injected, opens kept", M.architectPrelude("import Mathlib\nopen Nat\n\ntheorem t"), `set_option maxRecDepth ${D}\nset_option maxHeartbeats ${H}\nopen Nat`)
eq("blueprint's own ceiling respected at boost 1", M.architectPrelude("import Mathlib\nset_option maxRecDepth 40\n"), `set_option maxHeartbeats ${H}\nset_option maxRecDepth 40`)
eq("boost overrides the blueprint's ceiling", M.architectPrelude("import Mathlib\nset_option maxRecDepth 40\n", 4), `set_option maxRecDepth ${D * 4}\nset_option maxHeartbeats ${H * 4}`)
eq("stops at the first declaration", M.architectPrelude("import Mathlib\nopen Nat\ntheorem t : P\nopen Foo"), `set_option maxRecDepth ${D}\nset_option maxHeartbeats ${H}\nopen Nat`)
ok("boost below 1 is clamped", M.architectPrelude("import Mathlib\n", 0).includes(`maxRecDepth ${D}`))

// ---------------------------------------------------------------------------
console.log("\n== architectNodePrefix (compile context) ==")
// ---------------------------------------------------------------------------
const graph = [
  { name: "d", kind: "def", signature: "def d : Nat", declTextNoAttr: "def d : Nat := 7" },
  { name: "a", kind: "lemma", signature: "lemma a : True", declTextNoAttr: "" },
  { name: "b", kind: "theorem", signature: "theorem b : True", declTextNoAttr: "" },
]
const pre = M.architectNodePrefix(graph, "b")
ok("defs carry real bodies", pre.includes("def d : Nat := 7"))
ok("earlier lemmas are sorried", pre.includes("lemma a : True := by sorry"))
ok("the node itself is excluded", !pre.includes("theorem b"))
eq("first node has empty prefix", M.architectNodePrefix(graph, "d"), "")

// ---------------------------------------------------------------------------
console.log("\n== architectStripVerdicts ==")
// ---------------------------------------------------------------------------
ok("PROVED marker removed", !M.architectStripVerdicts("theorem t : P\n-- PROVED").includes("PROVED"))
ok("diagnosis block removed", !M.architectStripVerdicts("theorem t : P\n-- UNPROVED\n/- Diagnosis\n## Class: X\n-/").includes("Diagnosis"))
ok("declaration survives", M.architectStripVerdicts("theorem t : P\n-- PROVED").includes("theorem t : P"))

// ---------------------------------------------------------------------------
console.log("\n== architectAnnotate (what refinement is allowed to do) ==")
// ---------------------------------------------------------------------------
const g1 = [{ name: "a", kind: "lemma", declText: "lemma a : True := by sorry_using []" }]
const blank = { analysis: "", facts: [], deadNames: [], rejected: [], helpers: [], note: "" }

const proved = M.architectAnnotate(g1, new Map([["a", { solved: true }]]), new Map())
ok("PROVED marker warns the proof is banked", /-- PROVED \(verified proof banked/.test(proved))

for (const cls of Object.keys(M.ARCHITECT_CLASSES)) {
  const out = M.architectAnnotate(g1, new Map([["a", { solved: false }]]), new Map([["a", { ...blank, class: cls }]]))
  ok(`class ${cls}: emitted`, out.includes(`## Class: ${cls}`))
  ok(`class ${cls}: directive emitted`, out.includes(M.ARCHITECT_CLASSES[cls].directive.slice(0, 40)))
}

const rich = M.architectAnnotate(
  g1,
  new Map([["a", { solved: false }]]),
  new Map([
    [
      "a",
      {
        class: "SUSPECT_STATEMENT",
        analysis: "prover gave up",
        facts: ["#eval (4*9 : ℕ)  ⇒  36"],
        deadNames: ["Nat.nope"],
        rejected: ["h1 — REFUTED by the compiler"],
        helpers: [{ signature: "theorem h2 : 2 = 2", why: "bridge" }],
        note: "unproved parents: b",
      },
    ],
  ]),
)
ok("verified fact carried", /36/.test(rich))
ok("nonexistent name carried", /Nat\.nope/.test(rich))
ok("rejected proposal carried", /REFUTED by the compiler/.test(rich))
ok("verified helper carried", /theorem h2 : 2 = 2/.test(rich))
ok("note carried", /unproved parents: b/.test(rich))
ok("SUSPECT_STATEMENT forbids deletion", /Do NOT delete/i.test(rich))

const dis = M.architectAnnotate(g1, new Map([["a", { solved: false, negated: true }]]), new Map([["a", { ...blank, class: "DISPROVED" }]]))
ok("DISPROVED licenses restatement", /MUST change it or drop it/.test(dis))
const pm = M.architectAnnotate(g1, new Map([["a", { solved: false }]]), new Map([["a", { ...blank, class: "PARENTS_MISSING" }]]))
ok("PARENTS_MISSING forbids helpers", /Do NOT add helper lemmas/.test(pm))
const hl = M.architectAnnotate(g1, new Map([["a", { solved: false }]]), new Map([["a", { ...blank, class: "HARNESS_LIMIT" }]]))
ok("HARNESS_LIMIT freezes the node", /COMPLETELY UNCHANGED/.test(hl))

ok(
  "diagnostician runs only where it changes the outcome",
  [...M.ARCHITECT_DIAGNOSE_CLASSES].sort().join(",") === "DISPROVED,PROOF_TOO_HARD,SUSPECT_STATEMENT",
  [...M.ARCHITECT_DIAGNOSE_CLASSES].join(","),
)
ok("non-lemma nodes are passed through unannotated", M.architectAnnotate([{ name: "d", kind: "def", declText: "def d : Nat := 7" }], new Map(), new Map()) === "def d : Nat := 7")

// ---------------------------------------------------------------------------
console.log("\n== glue nodes (assembly verified at admission) ==")
// ---------------------------------------------------------------------------
const gGlue = [{ name: "t", kind: "theorem", glue: true, body: "by exact h", declText: "theorem t : True := by exact h" }]
const asmMark = M.architectAnnotate(gGlue, new Map([["t", { solved: true }]]), new Map())
ok("glue node marked ASSEMBLY, not banked-PROVED", /-- ASSEMBLY/.test(asmMark) && !/-- PROVED/.test(asmMark))
ok("ASSEMBLY marker stripped on round-trip", !M.architectStripVerdicts(asmMark).includes("ASSEMBLY"))
ok("full PROVED line stripped on round-trip", !M.architectStripVerdicts(proved).includes("PROVED"))
ok("the glue declaration itself survives the strip", M.architectStripVerdicts(asmMark).includes("theorem t : True := by exact h"))
const helperElab = M.architectAnnotate(
  g1,
  new Map([["a", { solved: false }]]),
  new Map([["a", { ...blank, class: "PROOF_TOO_HARD", helpers: [{ signature: "theorem h3 : 3 = 3", why: "w", elaborated: "h3 : (3 : ℤ) = (3 : ℤ)" }] }]]),
)
ok("helper's elaborated form carried to the refiner", /as Lean elaborates it: h3 : \(3 : ℤ\)/.test(helperElab))
ok("PROOF_TOO_HARD directive teaches the type-mismatch rule", /RESTATE that parent/.test(M.ARCHITECT_CLASSES.PROOF_TOO_HARD.directive))

// ---------------------------------------------------------------------------
console.log("\n== consultant plumbing ==")
// ---------------------------------------------------------------------------
const tr = M.makeAgentTrace("A1")
ok("trace opens with an empty history and no consults", Array.isArray(tr.history) && tr.history.length === 0 && tr.consults === 0)
for (let i = 1; i <= 6; i++) M.traceSubmission(tr, "lean_compile", { code: `by v${i}` })
eq("history is a ring of the last 4 submissions", tr.history, ["by v3", "by v4", "by v5", "by v6"])
ok("non-code tool calls do not enter the history", (M.traceSubmission(tr, "loogle_search", { query: "x" }), tr.history.length === 4))
ok("consult fires at the 3rd identical error, bounded per conversation", M.ARCHITECT_CONSULT_STREAK === 2 && M.ARCHITECT_CONSULT_MAX >= 1)

// ---------------------------------------------------------------------------
console.log("\n== proof bank (a verified proof survives later failed runs) ==")
// ---------------------------------------------------------------------------
try { rmSync(BANK_TMP, { force: true }) } catch {}
ok("bank path honours the env override", M.PROOF_BANK_PATH === BANK_TMP)
const THM = "theorem bank_t : 1 = 1 := by\n  norm_num"
const TC32 = "v4.32.0 / Mathlib v4.32.0"
const TC29 = "v4.29.1 / Mathlib v4.29.1"

const s1 = M.proofBankStore({ theorem: THM, toolchain: TC32, group: "architect", strategy: "leak-ultra", proof: "by rfl", runId: "r1" })
ok("ultra's proof stored", s1.stored && !s1.replaced)
const hit = M.proofBankFind(THM, TC32)
ok("failed river run can retrieve it", hit && hit.proof === "by rfl" && hit.strategy === "leak-ultra")
ok("missing entry is null, not a throw", M.proofBankFind("theorem other_t : 2 = 2 := by sorry", TC32) === null)

const s2 = M.proofBankStore({ theorem: THM, toolchain: TC32, group: "architect", strategy: "river-stone", proof: "by norm_num", runId: "r2" })
ok("same theorem + same toolchain REPLACES (no duplicate)", s2.stored && s2.replaced)
ok("one entry per (theorem, toolchain)", Object.keys(M.proofBankRead().entries).length === 1)
const after = M.proofBankFind(THM, TC32)
ok("newest proof wins, provenance survives", after.proof === "by norm_num" && after.firstProvedBy === "leak-ultra")

M.proofBankStore({ theorem: THM, toolchain: TC29, group: "stronghold", strategy: "have-tree", proof: "by decide", runId: "r3" })
ok("a DIFFERENT toolchain is a separate certificate", Object.keys(M.proofBankRead().entries).length === 2)
ok("each toolchain retrieves its own proof", M.proofBankFind(THM, TC29).proof === "by decide" && M.proofBankFind(THM, TC32).proof === "by norm_num")

// Keying is on the normalized SIGNATURE: whitespace and the lemma/theorem
// keyword must not fork entries, and the placeholder body must not matter.
const k1 = M.proofBankKey("theorem bank_t : 1 = 1 := by\n  norm_num", TC32).key
const k2 = M.proofBankKey("lemma  bank_t :  1 = 1 := by sorry", TC32).key
ok("lemma/theorem + whitespace + body do not fork the key", k1 === k2)
try { rmSync(BANK_TMP, { force: true }) } catch {}
try { rmSync(`${BANK_TMP}.tmp`, { force: true }) } catch {}

// ---------------------------------------------------------------------------
console.log("\n== target pre-flight is advisory (source invariant) ==")
// ---------------------------------------------------------------------------
// Source invariant, not a unit test — the pre-flight lives inside
// proveArchitect. It is pinned because the first cut was FATAL on any Lean
// error, which contradicted the other half of the same feature: supporting
// declarations exist so a target that does not elaborate alone can be made to.
// insane_lamp_circle needs an `instance : NeZero N`; the fatal gate rejected
// the problem one second in, before the model was ever asked to supply it.
{
  const src = readFileSync(bridgePath(), "utf8")
  const start = src.indexOf("Pre-flight: does the TARGET elaborate")
  ok("pre-flight block is present", start > 0)
  const block = src.slice(start, start + 2600)
  ok("pre-flight never aborts the run", !/return \{ verified: false/.test(block))
  ok("pre-flight builds a note for the blueprint stage", /targetPreflightNote\s*=/.test(block))
  ok("the note tells the model to write it WITHOUT @[blueprint]", /WITHOUT an .{0,3}@\[blueprint\]/.test(block))
  ok("the note actually reaches the blueprint user prompt",
     /const bpUser = [\s\S]{0,400}\$\{targetPreflightNote\}/.test(src))
}

// ---------------------------------------------------------------------------
console.log("\n== blueprint capture guard (source invariant) ==")
// ---------------------------------------------------------------------------
// Not a unit test — the capture lives inside architectBlueprintStage's closure
// and cannot be extracted. But the invariant is worth pinning: an exploration
// compile ALSO reports ok (it means "Lean found no errors") and carries no
// graph. Capturing on `ok` alone ended the blueprint stage on a bare `#eval`
// and killed the run with `bp.graph is not iterable`. Live on
// ferris_wheel_colorings, minutes after the #eval hatch shipped.
{
  const src = readFileSync(bridgePath(), "utf8")
  const captures = [...src.matchAll(/captured = \{ graph:/g)]
  ok("blueprint graph is captured in exactly one place", captures.length === 1, `${captures.length}`)
  for (const m of captures) {
    const before = src.slice(Math.max(0, m.index - 300), m.index)
    ok("capture is gated on an actual array graph, not on ok alone", /Array\.isArray\(r\.graph\)/.test(before))
  }
}

// ---------------------------------------------------------------------------
console.log("\n== architectAssemble ==")
// ---------------------------------------------------------------------------
const asmGraph = [
  { name: "d", kind: "def", signature: "def d : Nat", declTextNoAttr: "def d : Nat := 7" },
  { name: "a", kind: "lemma", signature: "lemma a : True", declTextNoAttr: "" },
]
const asm = M.architectAssemble(asmGraph, "set_option maxRecDepth 8000", new Map([["a", "by trivial"]]))
ok("imports Mathlib", asm.startsWith("import Mathlib"))
ok("prelude carried into the assembled file", asm.includes("set_option maxRecDepth 8000"))
ok("def emitted with its real body", asm.includes("def d : Nat := 7"))
ok("lemma emitted with its banked proof", /lemma a : True :=\n\s+by trivial/.test(asm))
ok("no blueprint attributes leak into the final file", !asm.includes("@[blueprint"))
ok("no sorry_using leaks into the final file", !asm.includes("sorry_using"))

// ---------------------------------------------------------------------------
console.log()
if (fails.length) {
  console.log(`${fails.length} FAILING: ${fails.join(", ")}`)
  process.exit(1)
}
console.log("all green")
