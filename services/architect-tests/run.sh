#!/usr/bin/env bash
# Full parser + gate suite for the architect stack.
#
#   bash services/architect-tests/run.sh              # default fuzz budget
#   FUZZ=20000 bash services/architect-tests/run.sh   # deeper differential
#
# Exit 0 only if every stage is green.
set -uo pipefail
cd "$(dirname "$0")/../.."

FUZZ="${FUZZ:-3000}"
SEEDS="${SEEDS:-1 7 42 20260727 999983}"
rc=0

hr() { printf '\n\033[1m%s\033[0m\n' "$1"; }

hr "1/3  blueprint.py — splitter, safeguards, graph validation"
python3 services/architect-tests/test_blueprint.py | tail -3 || rc=1

hr "2/3  claude-bridge.mjs — signature extraction, classification, assembly"
node services/architect-tests/test_bridge.mjs | tail -3 || rc=1

hr "3/3  differential — the two splitters must agree"
# Both implement the same rule in different languages. Every parser defect
# found in this stack so far was that rule implemented wrongly in BOTH, so
# hand-written cases alone are not evidence; these are generated.
for seed in $SEEDS; do
  node services/architect-tests/differential.mjs "$FUZZ" "$seed" | tail -1 || rc=1
done

hr "result"
if [ "$rc" -eq 0 ]; then echo "all green"; else echo "FAILURES — see above"; fi
exit "$rc"
