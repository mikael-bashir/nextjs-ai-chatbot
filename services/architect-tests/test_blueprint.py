#!/usr/bin/env python3
"""Parser + gate tests for services/hf-spaces/leak-*/shared/blueprint.py.

Run:  python3 services/architect-tests/test_blueprint.py
Exit 0 = all green. No dependencies beyond the stdlib.

Two halves:
  * the shared corpus (corpus.json) — the declaration splitter, held to the
    same expectations as the JS side so the two cannot drift;
  * blueprint.py's own gates — safeguards, graph validation, set_option
    whitelisting, attribute stripping, topological order.
"""

import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
SHARED = os.path.join(HERE, "..", "hf-spaces", "leak-xii", "shared")
sys.path.insert(0, SHARED)

import blueprint as bp  # noqa: E402

FAILS = []


def check(label, got, want):
    if got == want:
        print(f"PASS {label}")
    else:
        FAILS.append(label)
        print(f"FAIL {label}\n   got  {got!r}\n   want {want!r}")


def check_true(label, cond, detail=""):
    check(label, bool(cond), True) if cond else (
        FAILS.append(label) or print(f"FAIL {label}{(' — ' + detail) if detail else ''}")
    )
    if cond:
        pass


def ok(label, cond, detail=""):
    if cond:
        print(f"PASS {label}")
    else:
        FAILS.append(label)
        print(f"FAIL {label}{(' — ' + detail) if detail else ''}")


def parse_one(lean):
    chunks, spans = bp.split_decls(lean)
    nodes = [n for n in (bp.parse_decl(c, s) for c, s in zip(chunks, spans)) if n]
    return nodes[0] if nodes else None


# ---------------------------------------------------------------------------
print("== shared corpus: declaration splitting ==")
# ---------------------------------------------------------------------------
with open(os.path.join(HERE, "corpus.json"), encoding="utf-8") as f:
    CORPUS = json.load(f)["cases"]

for c in CORPUS:
    n = parse_one(c["lean"])
    if n is None:
        FAILS.append(c["id"])
        print(f"FAIL corpus/{c['id']} — nothing parsed")
        continue
    check(f"corpus/{c['id']}/sig", n.signature.strip(), c["sig"].strip())
    want_body = "" if c["body"] is None else c["body"]
    check(f"corpus/{c['id']}/body", n.body.strip(), want_body.strip())

# ---------------------------------------------------------------------------
print("\n== strip_comments ==")
# ---------------------------------------------------------------------------
ok("line comment blanked", "secret" not in bp.strip_comments("a -- secret\nb"))
ok("block comment blanked", "secret" not in bp.strip_comments("a /- secret -/ b"))
ok("nested block comment blanked", "secret" not in bp.strip_comments("a /- x /- secret -/ y -/ b"))
ok("newlines preserved", bp.strip_comments("a -- x\nb").count("\n") == 1)
ok("offsets preserved", len(bp.strip_comments("a /- xxx -/ b")) == len("a /- xxx -/ b"))
ok("string content survives", "secret" in bp.strip_comments('a "secret" b'))
ok("-- inside string is not a comment", "keep" in bp.strip_comments('a "-- keep" b'))
ok("/- inside string is not a comment", "keep" in bp.strip_comments('a "/- keep" b'))
ok("escaped quote does not end string", "keep" in bp.strip_comments('a "x \\" -- keep" b'))

ok("balanced: plain", bp.block_comments_balanced("/- a -/"))
ok("balanced: nested", bp.block_comments_balanced("/- a /- b -/ c -/"))
ok("unbalanced: unclosed", not bp.block_comments_balanced("/- a"))
ok("unbalanced: extra close", not bp.block_comments_balanced("a -/"))

# ---------------------------------------------------------------------------
print("\n== normalize_sig ==")
# ---------------------------------------------------------------------------
check("collapses whitespace", bp.normalize_sig("theorem  t\n  :  1 = 1"), "theorem t : 1 = 1")
check("lemma == theorem", bp.normalize_sig("lemma t : P"), bp.normalize_sig("theorem t : P"))
ok("different names differ", bp.normalize_sig("theorem a : P") != bp.normalize_sig("theorem b : P"))

# ---------------------------------------------------------------------------
print("\n== forbidden constructs ==")
# ---------------------------------------------------------------------------
os.environ.pop("ARCHITECT_ALLOW_NATIVE_DECIDE", None)
ok("axiom always banned", bp.forbidden_violations("axiom foo : True"))
ok("native_decide allowed by default", not bp.forbidden_violations("by native_decide"))
os.environ["ARCHITECT_ALLOW_NATIVE_DECIDE"] = "0"
ok("native_decide banned when disabled", bp.forbidden_violations("by native_decide"))
ok("axiom still banned when native disabled", bp.forbidden_violations("axiom f : True"))
os.environ["ARCHITECT_ALLOW_NATIVE_DECIDE"] = "1"
ok("substring 'axiomatic' is not axiom", not bp.forbidden_violations("Nat.axiomatic"))
ok("substring 'native_decideX' is not native_decide", not bp.forbidden_violations("native_decideFoo"))
ok("dotted Foo.axiom is not the keyword", not bp.forbidden_violations("Foo.axiom"))

# ---------------------------------------------------------------------------
print("\n== set_option whitelist ==")
# ---------------------------------------------------------------------------
acc, bad = bp.extract_set_options("set_option maxRecDepth 4000 in\ntheorem t : True := by trivial")
check("accepts maxRecDepth (in-form)", (acc, bad), (["set_option maxRecDepth 4000"], []))
acc, bad = bp.extract_set_options("set_option maxHeartbeats 800000")
check("accepts maxHeartbeats", (acc, bad), (["set_option maxHeartbeats 800000"], []))
acc, bad = bp.extract_set_options("set_option synthInstance.maxHeartbeats 40000")
check("accepts synthInstance.*", (acc, bad), (["set_option synthInstance.maxHeartbeats 40000"], []))
acc, bad = bp.extract_set_options("set_option pp.all true")
ok("rejects non-resource option", not acc and len(bad) == 1)
acc, bad = bp.extract_set_options("-- set_option maxRecDepth 9 in\ntheorem t : True := by trivial")
check("ignores commented-out option", (acc, bad), ([], []))
acc, _ = bp.extract_set_options("set_option maxRecDepth 10\nset_option maxRecDepth 10")
check("de-duplicates", acc, ["set_option maxRecDepth 10"])

# ---------------------------------------------------------------------------
print("\n== precheck_blueprint ==")
# ---------------------------------------------------------------------------
TARGET = "theorem main_t : 1 = 1"
# The main theorem is the ASSEMBLY: a real, sorry-free glue proof. Interior
# nodes default to `sorry_using [...]` (a node for the prover) and MAY instead
# carry sorry-free glue of their own.
GOOD = (
    "import Mathlib\nimport Architect\n\n"
    "@[blueprint\n  (statement := /-- s -/)\n  (proof := /-- p -/)]\n"
    "theorem main_t : 1 = 1 := by rfl\n"
)
check("clean blueprint passes", bp.precheck_blueprint(GOOD, "main_t", TARGET), [])


def viol(code, target=TARGET, name="main_t"):
    return " | ".join(bp.precheck_blueprint(code, name, target))


ok("missing import Mathlib", "import Mathlib" in viol(GOOD.replace("import Mathlib\n", "")))
ok("missing import Architect", "import Architect" in viol(GOOD.replace("import Architect\n", "")))
ok("missing main theorem", "missing main theorem" in viol(GOOD, name="other_t"))
ok("signature mismatch", "does not match" in viol(GOOD, target="theorem main_t : 2 = 2"))
ok("unbalanced block comment", "unbalanced" in viol(GOOD + "\n/- oops\n"))
ok("axiom rejected", "axiom" in viol(GOOD + "\naxiom bad : True\n"))
ok("main with sorry_using rejected", "real ASSEMBLY" in viol(GOOD.replace("by rfl", "by sorry_using []")))
ok("main with bare sorry rejected", "may not contain 'sorry'" in viol(GOOD.replace("by rfl", "by sorry")))
ok(
    "main glue hiding a sorry rejected",
    "may not contain 'sorry'" in viol(GOOD.replace("by rfl", "by have h : True := by sorry\n  rfl")),
)
ok(
    "interior sorry_using node passes",
    viol(GOOD + "\n@[blueprint (statement := /-- s -/) (proof := /-- p -/)]\nlemma extra : True := by sorry_using []\n") == "",
)
ok(
    "interior glue node passes",
    viol(GOOD + "\n@[blueprint (statement := /-- s -/) (proof := /-- p -/)]\nlemma extra : True := by trivial\n") == "",
)
ok(
    "interior bare sorry rejected",
    "bare 'sorry' is neither" in viol(GOOD + "\n@[blueprint (statement := /-- s -/) (proof := /-- p -/)]\nlemma extra : True := by sorry\n"),
)
ok(
    "lemma without @[blueprint]",
    "without an '@[blueprint]'" in viol(GOOD + "\nlemma extra : True := by sorry_using []\n"),
)
ok(
    "def with sorry_using rejected",
    "real Lean body" in viol(GOOD + "\n@[blueprint (statement := /-- d -/)]\ndef d : Nat := by sorry_using []\n"),
)
ok("bad set_option rejected", "not permitted" in viol("set_option pp.all true\n" + GOOD))

# the live regression: a let-bearing target must pass its own signature gate
LET_TARGET = "theorem lt :\n    let a : Nat := 3\n    a = 3"
LET_CODE = (
    "import Mathlib\nimport Architect\n\n"
    "@[blueprint\n  (statement := /-- s -/)\n  (proof := /-- p -/)]\n" + LET_TARGET + " := by decide\n"
)
check("let-bearing target passes precheck", bp.precheck_blueprint(LET_CODE, "lt", LET_TARGET), [])

# ---------------------------------------------------------------------------
print("\n== glue parsing + dep scan ==")
# ---------------------------------------------------------------------------
n = parse_one("@[blueprint (statement := /-- s -/) (proof := /-- p -/)]\ntheorem t : True := by sorry_using [a]")
ok("sorry_using body is not glue", n is not None and not n.glue)
n = parse_one("@[blueprint (statement := /-- s -/) (proof := /-- p -/)]\ntheorem t : True := by trivial")
ok("real proof body is glue", n is not None and n.glue)
n = parse_one("def d : Nat := 3")
ok("a def is never glue", n is not None and not n.glue)

GLUE_FILE = (
    "import Mathlib\nimport Architect\n\n"
    "@[blueprint (statement := /-- s -/) (proof := /-- p -/)]\n"
    "lemma helper_h (n : Nat) : n = n := by sorry_using []\n\n"
    "@[blueprint (statement := /-- s -/) (proof := /-- p -/)]\n"
    "theorem main_t : 1 = 1 := by exact helper_h 1\n"
)
v, nodes = bp.validate_graph(GLUE_FILE, "main_t")
check("glue graph valid (no dead helper)", v, [])
main_node = next(n for n in nodes if n.name == "main_t")
check("glue deps scanned from the body", main_node.deps, ["helper_h"])
# A name cited only in a comment is NOT a dependency.
v, nodes = bp.validate_graph(
    GLUE_FILE.replace("by exact helper_h 1", "by rfl -- helper_h is unrelated"), "main_t")
ok("comment mention is not a dep", any("reachable" in x for x in v))
# Explicit (uses := [...]) still counts for glue nodes.
v, nodes = bp.validate_graph(
    GLUE_FILE.replace("(statement := /-- s -/) (proof := /-- p -/)]\ntheorem main_t : 1 = 1 := by exact helper_h 1",
                      "(statement := /-- s -/) (proof := /-- p -/) (uses := [helper_h])]\ntheorem main_t : 1 = 1 := by norm_num"),
    "main_t")
check("explicit uses on glue node valid", v, [])

# ---------------------------------------------------------------------------
print("\n== validate_graph ==")
# ---------------------------------------------------------------------------
def bpfile(*decls):
    return "import Mathlib\nimport Architect\n\n" + "\n\n".join(decls) + "\n"


def node(name, deps="", statement="s", proof="p", concl="True"):
    attr = f"@[blueprint\n  (statement := /-- {statement} -/)"
    if proof is not None:
        attr += f"\n  (proof := /-- {proof} -/)"
    attr += "]"
    return f"{attr}\ntheorem {name} : {concl} := by sorry_using [{deps}]"


v, _ = bp.validate_graph(bpfile(node("main_t")), "main_t")
check("single-node graph valid", v, [])

v, _ = bp.validate_graph(bpfile(node("h"), node("main_t", deps="h")), "main_t")
check("two-node chain valid", v, [])

v, _ = bp.validate_graph(bpfile(node("h"), node("main_t")), "main_t")
ok("dead node detected", any("reachable" in x for x in v))

v, _ = bp.validate_graph(bpfile(node("main_t", deps="Nat.succ_le")), "main_t")
ok("Mathlib name as dep rejected", any("does not resolve" in x for x in v))

v, _ = bp.validate_graph(bpfile(node("main_t", deps="main_t")), "main_t")
ok("self-loop detected", any("self-loop" in x for x in v))

v, _ = bp.validate_graph(bpfile(node("a", deps="b"), node("b", deps="a"), node("main_t", deps="a")), "main_t")
ok("cycle detected", any("acyclic" in x for x in v))

v, _ = bp.validate_graph(bpfile(node("main_t", proof=None)), "main_t")
ok("missing proof field detected", any("proof" in x for x in v))

v, _ = bp.validate_graph(bpfile(node("main_t"), node("main_t")), "main_t")
ok("duplicate names detected", any("duplicate" in x for x in v))

v, _ = bp.validate_graph(bpfile(node("other")), "main_t")
ok("missing main theorem detected", any("exactly one main Theorem" in x for x in v))

# ---------------------------------------------------------------------------
print("\n== topo_order ==")
# ---------------------------------------------------------------------------
_, nodes = bp.validate_graph(bpfile(node("c", deps="b"), node("b", deps="a"), node("a"), node("main_t", deps="c")), "main_t")
order = [n.name for n in bp.topo_order(nodes)]
ok("parents precede children", order.index("a") < order.index("b") < order.index("c") < order.index("main_t"), str(order))

# ---------------------------------------------------------------------------
print("\n== strip_blueprint_attr ==")
# ---------------------------------------------------------------------------
s = bp.strip_blueprint_attr("@[blueprint (statement := /-- s -/)]\ntheorem t : True := by trivial")
ok("blueprint attribute removed", "blueprint" not in s and "theorem t" in s)
s = bp.strip_blueprint_attr("@[simp, blueprint (statement := /-- s -/)]\ntheorem t : True := by trivial")
ok("co-listed @[simp] kept", "simp" in s and "blueprint" not in s)
s = bp.strip_blueprint_attr("theorem t : True := by trivial")
ok("no attribute is a no-op", s.startswith("theorem t"))

# ---------------------------------------------------------------------------
print("\n== split_decls ==")
# ---------------------------------------------------------------------------
chunks, _ = bp.split_decls(bpfile(node("a"), node("b"), node("main_t", deps="a, b")))
check("three declarations found", len(chunks), 3)
chunks, _ = bp.split_decls("import Mathlib\n\ntheorem a : True := by trivial\ntheorem b : True := by trivial")
check("adjacent decls split", len(chunks), 2)
n = parse_one(node("main_t", deps="a, b"))
check("deps parsed in order", n.deps, ["a", "b"])
n = parse_one(node("main_t", deps="a, a, b"))
check("deps de-duplicated", n.deps, ["a", "b"])

# ---------------------------------------------------------------------------
print("\n== supporting declarations (un-annotated def/instance) ==")
# ---------------------------------------------------------------------------
# `insane_lamp_circle` needs `NeZero N` for `Fintype (ZMod N)` to exist at all.
# The driver worked that out, added the instance, and got "isolated/dead nodes:
# neZeroOfEqN" — so the blueprint could never validate and the run spun on
# attempt 1 until its budget ran out. A definition with no `@[blueprint]` is now
# support: exempt from the statement field and from reachability, still returned
# in `nodes` so it reaches node prefixes and the assembled file.
MAIN_T = ("@[blueprint (statement := /-- s -/) (proof := /-- p -/)]\n"
          "theorem main_t : True := by sorry_using []")


def gv(code, target="main_t"):
    return bp.validate_graph(code, target)


v, nodes = gv("instance foo : NeZero 3 := ⟨by norm_num⟩\n\n" + MAIN_T)
ok("un-annotated instance is accepted", v == [], "; ".join(v))
ok("...and is still returned for assembly", [n.name for n in nodes] == ["foo", "main_t"])
v, _ = gv("def powMod (b e m : Nat) : Nat := b\n\n" + MAIN_T)
ok("un-annotated helper def is accepted", v == [], "; ".join(v))
# Everything that was strict stays strict.
v, _ = gv("@[blueprint]\ndef bar : Nat := 7\n\n" + MAIN_T)
ok("an ANNOTATED def with no statement is still rejected", any("statement" in x for x in v))
v, _ = gv("@[blueprint (statement := /-- s -/)]\ndef bar : Nat := 7\n\n" + MAIN_T)
ok("an ANNOTATED unreachable def is still dead", any("dead nodes" in x for x in v))
v, _ = gv("theorem sneaky : True := by trivial\n\n" + MAIN_T)
ok("a theorem is never support, however it is written", v != [])

# ---------------------------------------------------------------------------
print("\n== is_exploration_only (the #eval escape hatch) ==")
# ---------------------------------------------------------------------------
# Both stage prompts tell the model to CHECK a constant with a bare `#eval`.
# In blueprint mode that submission used to hit precheck_blueprint and come
# back as "missing import Mathlib / missing import Architect / missing main
# theorem". Live consequence on `factorial_base12_trailing_zeros`: the
# generator tried twice, gave up, and guessed 2023 and 1009 — both wrong, both
# disproved by node provers, two refinement iterations burned.
ok("the exact submission that was rejected live",
   bp.is_exploration_only("#eval (Nat.factorial 2026).factorization 2\n#eval Nat.digits 3 2026"))
ok("#check", bp.is_exploration_only("#check padicValNat.mul"))
ok("example with no blueprint decl", bp.is_exploration_only("example : 1 = 1 := by rfl\n#eval 2+2"))
ok("a real blueprint is NOT exploration",
   not bp.is_exploration_only(bpfile(node("main_t"))))
ok("a blueprint that also evals is still a blueprint",
   not bp.is_exploration_only(bpfile(node("main_t")) + "\n#eval 1"))
# Scratch definitions are part of asking the compiler a question. Requiring
# "declares nothing" forced shuffled_tables_mod's driver to inline an entire
# modular-exponentiation routine into one `#eval` full of `let`s, after three
# rejected attempts at smuggling the `def`s into the blueprint.
ok("scratch defs alongside an eval are exploration",
   bp.is_exploration_only("def powMod (b e m : Nat) : Nat := b\n#eval powMod 2 10 1000"))
ok("@[simp, blueprint] still reads as a blueprint",
   not bp.is_exploration_only("@[simp, blueprint (statement := /-- s -/) (proof := /-- p -/)]\n"
                              "theorem t : True := by sorry_using []\n#eval 1"))
# The escape hatch must not swallow a broken blueprint: no info command means
# it still goes through the pre-checks and gets a structural error.
ok("malformed decl with no info command still prechecked",
   not bp.is_exploration_only("theorem broken : True :="))
ok("#eval inside a comment does not count",
   not bp.is_exploration_only("-- #eval 1\ntheorem t : True := by trivial"))
ok("empty input", not bp.is_exploration_only(""))

# ---------------------------------------------------------------------------
print()
if FAILS:
    print(f"{len(FAILS)} FAILING: {', '.join(FAILS)}")
    sys.exit(1)
print("all green")
