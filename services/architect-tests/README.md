# Architect parser tests

```sh
bash services/architect-tests/run.sh
```

No dependencies beyond `python3` and `node`. Exit 0 = green.

## Why this exists

Two parsers in this stack implement the *same* rule in different languages:

| | file | function |
|---|---|---|
| Python | `services/hf-spaces/leak-*/shared/blueprint.py` | `parse_decl` |
| JS | `public/local-claude-bridge.mjs` | `architectSignatureOf` |

Both must find the top-level `:=` that starts a declaration's proof body.
Every parser defect found here so far has been that rule implemented wrongly in
**both** places:

1. *"Split at the first top-level `:=`"* — broken by any statement containing a
   term-level binder, since `let x : T := v` puts a `:=` at depth 0 first. Live
   failure: `enclosing_circle_radius`, whose statement opens `let k1 : ℚ := 1`.
   The signature parsed as `theorem enclosing_circle_radius : let k1 : ℚ`, so
   the verbatim-signature gate could never pass and the remainder was read as
   the body. Both safeguard errors, every attempt, with no edit available to
   the model — it spent the entire stage probing a parser that was never going
   to look past the first `let`.
2. The bridge's `:=\s*by` regex, which cut at the *earliest* `:= by` and did not
   recognise term-mode bodies at all (`:= rfl` survived into the expected
   signature, making the gate unsatisfiable).
3. Neither scanner skipped string literals, so `theorem t : "a := b".length = 6`
   split inside the string.

Hand-written cases only cover mistakes already thought of. Hence the
differential fuzzer.

## Layout

| file | what it checks |
|---|---|
| `corpus.json` | 32 declarations with expected signature/body. Shared by both suites, so the implementations cannot drift. |
| `test_blueprint.py` | The corpus against `parse_decl`, plus `strip_comments`, `normalize_sig`, `precheck_blueprint`, `validate_graph`, `extract_set_options`, `forbidden_violations`, `strip_blueprint_attr`, `topo_order`, `split_decls`. |
| `test_bridge.mjs` | The corpus against `architectSignatureOf`, plus `architectSplitSig`, `architectNegSignature`, `architectPrelude`, `architectNodePrefix`, `architectIsResourceFailure`, `architectStripVerdicts`, `architectAnnotate` (every failure class and its directive), `architectAssemble`. |
| `differential.mjs` | Generates declarations from the grammar fragments that have historically broken these scanners and asserts the two implementations agree. Seeded, so a failure is reproducible. |
| `bridge-lib.mjs` | Slices named top-level declarations out of the bridge (it cannot be imported — it is a long-running script). Syntax-checks the extraction and asserts every symbol resolved, so a mis-slice fails loudly instead of silently testing nothing. |

## Two traps this suite is built to catch

**Bridge drift.** The bridge exists twice — `public/local-claude-bridge.mjs`
(shipped to operators) and `~/claude-bridge.mjs` (what runs). `test_bridge.mjs`
fails outright if they differ, rather than testing a file nobody runs. This
fired for real while the suite was being written.

**A vacuous fuzzer.** A differential test that always passes is worthless, so
its detection power was verified by mutation — reintroducing each historical
bug and confirming it is caught:

| mutation | mismatches / 800 |
|---|---|
| JS ignores `let`/`have` binders (bug 1) | 598 |
| JS stops skipping string literals (bug 3) | 216 |
| Python stops skipping string literals (bug 3) | 177 |
| *(unmutated)* | **0** |

## Adding a case

Put it in `corpus.json` — both suites pick it up. Only add expectations you can
justify against Lean's actual grammar; a wrong expectation asserted in two
languages is exactly the failure mode this directory exists to prevent.

## Known limits

* The scanners lex brackets, comments and strings, but not char literals
  (`'a'`) — deliberately, because `'` is legal in identifiers (`h'`) and a
  `:=` cannot fit inside a char literal anyway.
* The differential compares *signatures*. `parse_decl` additionally returns the
  body, which the Python suite checks against the corpus but the fuzzer does
  not cross-check, since `architectSignatureOf` does not compute one.
* These are unit tests. Nothing here talks to Lean; the compile, validation and
  refutation gates are only exercised end to end against a live Leak XII.
