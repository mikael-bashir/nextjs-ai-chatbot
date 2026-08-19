#!/usr/bin/env python3
"""Regression test for the blueprint-mode line-offset bug in Leak XII's
`_strip_imports` (services/hf-spaces/leak-xii/server.py and its REST twin
services/leak-xii/server.py).

`_strip_imports` used to DELETE import lines from the text handed to Lean.
`_compile_blueprint` and `_compile_explore` compile that text directly, so
every line below an import was silently shifted up by the import count —
Lean's own line numbers no longer matched what the model actually submitted.
Observed live: a blueprint submission's real failure was two lines below
what Lean reported, so the model kept "fixing" a tactic that was never the
one actually failing, across eight resubmissions.

The fix blanks import lines in place instead of deleting them, so every
other line keeps its original position. This test extracts `_strip_imports`
from BOTH server.py copies (they can't be imported directly — mcp/uvicorn/
nest_asyncio aren't installed here, and importing the live module would also
pull in module-level side effects) and checks the property directly: for any
code containing import lines anywhere, every non-import line's 0-based index
in the output is IDENTICAL to its index in the input.

Run:  python3 services/architect-tests/test_strip_imports.py
Exit 0 = all green. No dependencies beyond the stdlib.
"""

import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
SERVER_COPIES = [
    os.path.join(HERE, "..", "hf-spaces", "leak-xii", "server.py"),
    os.path.join(HERE, "..", "leak-xii", "server.py"),
]

FAILS = []


def ok(label, cond, detail=""):
    if cond:
        print(f"PASS {label}")
    else:
        FAILS.append(label)
        print(f"FAIL {label}{(' — ' + detail) if detail else ''}")


def extract_strip_imports(path):
    src = open(path, encoding="utf-8").read()
    m = re.search(r"^def _strip_imports\(.*?\n(?=^def )", src, re.M | re.S)
    if not m:
        raise RuntimeError(f"_strip_imports not found in {path}")
    ns = {"re": re}
    exec(m.group(0), ns)
    return ns["_strip_imports"]


CASES = [
    # (label, code)
    ("imports only at top", "import Mathlib\nimport Architect\n\ntheorem t : True := by trivial\n"),
    ("single import", "import Mathlib\n\nexample : 1 = 1 := by rfl\n"),
    ("no imports", "theorem t : True := by trivial\n"),
    ("import mid-file (malformed input, still must not shift)",
     "theorem a : True := by trivial\nimport Mathlib\ntheorem b : True := by trivial\n"),
    ("blank lines interleaved with imports",
     "import Mathlib\n\nimport Architect\n\n\ntheorem t : True := by trivial\n"),
]

for path in SERVER_COPIES:
    strip_imports = extract_strip_imports(path)
    label_path = os.path.relpath(path, os.path.join(HERE, "..", ".."))
    print(f"\n== {label_path} ==")
    for label, code in CASES:
        body, imports = strip_imports(code)
        orig_lines = code.split("\n")
        new_lines = body.split("\n")
        ok(f"{label}: line count preserved",
           len(new_lines) == len(orig_lines),
           f"got {len(new_lines)}, want {len(orig_lines)}")
        # Every NON-import line must sit at the exact same index as in the
        # original -- this is the property that makes Lean's own line
        # numbers correct without any further correction.
        mismatches = [
            i for i, (o, n) in enumerate(zip(orig_lines, new_lines))
            if not re.match(r"^\s*import\s+\S+", o) and o != n
        ]
        ok(f"{label}: non-import lines unshifted", not mismatches, f"mismatched indices: {mismatches}")
        # Every import line the function reports finding must be blanked
        # (not merely absent) at its ORIGINAL position.
        import_positions = [i for i, o in enumerate(orig_lines) if re.match(r"^\s*import\s+\S+", o)]
        ok(f"{label}: import lines blanked in place, not deleted",
           all(new_lines[i] == "" for i in import_positions if i < len(new_lines)))
        ok(f"{label}: import list captured correctly",
           imports == [orig_lines[i].strip() for i in import_positions])

print()
if FAILS:
    print(f"{len(FAILS)} FAILING: {FAILS}")
    sys.exit(1)
print("all green")
