# Leak Architect stack — Goedel-Architect on Leak XI / XII / XIV

Replication of **Goedel-Architect** (arXiv 2606.06468) as a Leak strategy:
blueprint generation → parallel isolated node proving → global blueprint
refinement, on the real **LeanArchitect** package
([hanwenzhu/LeanArchitect](https://github.com/hanwenzhu/LeanArchitect),
Lean `v4.32.0` + Mathlib `v4.32.0`), driven by **Grok 4.1** (the closest
available analogue of the paper's DeepSeek-V4-Flash backbone).

## The services

| Service | Port | Role (paper tool) | Weight |
|---|---|---|---|
| **Leak XI** | 8011 | `mathlib_search` — declaration lookup over Mathlib (FTS5, subtoken-aware) | ~200 MB |
| **Leak XII** | 8012 | `lean_compile` — safeguard pre-checks → warm-daemon compile → blueprint graph validation; node-mode canonical rebuild + negation channel | 2 warm Lean daemons, ~5 GB each |
| **Leak XIV** | 8014 | certification gate — compiles the assembled final proof end-to-end; the ONLY exit that counts | 1 lazy daemon |

The Roman numerals follow the house convention: XI ↔ search (like I),
XII ↔ live compile workspace (like II), XIV ↔ final verifier (like IV).
XIII does not exist for the same reason III no longer does.

## Deploy (Oracle Always Free, arm64)

```sh
git clone <this repo> leak && cd leak/services/architect-deploy
bash bootstrap.sh
```

First build ≈ 30–60 min (Mathlib olean cache download + LeanArchitect + REPL
compile). The compose file caps memory so the 12 GB shape survives; on a
24 GB PAYG shape set `XII_POOL_SIZE=3` or `4`.

**Also open ports 8011/8012/8014 in the subnet Security List** (OCI console →
VCN → Security Lists → Ingress). The VM-local iptables rules are handled by
`bootstrap.sh`.

## Wire the bridge

The `architect` strategy runs inside the local Claude bridge but drives the
xAI API directly (no Claude CLI on this path). Start the bridge with:

```sh
XAI_API_KEY='<your xai key>' \
LEAK_XI_URL='http://<vm-ip>:8011' \
LEAK_XII_URL='http://<vm-ip>:8012' \
LEAK_XIV_URL='http://<vm-ip>:8014' \
ARCHITECT_MODEL='grok-4.1-fast-reasoning' \
  node claude-bridge.mjs
```

`ARCHITECT_MODEL` is optional — unknown models fall down a ladder
(`grok-4.1-fast-reasoning` → `grok-4.1-fast` → `grok-4.1` → …). Optional
tuning: `ARCHITECT_MAX_ITERS` (refinement iterations, default 8),
`ARCHITECT_NODE_CONCURRENCY` (parallel node provers, default 2 — match
XII's `POOL_SIZE`).

Then in the ACG pipeline (or playground/benchmark) pick the strategy
**Architect (Goedel blueprint · grok driver · Leak XI/XII/XIV)** with
decompose/tree mode ON.

## Paper-fidelity notes

* Budgets (Appendix A): blueprint 262,144 tokens/attempt ≤8 attempts; prover
  65,536/node-attempt ≤4; refinement 262,144 ≤8 per step; ≤8 refinement
  iterations per pass. The bridge's wall-clock governor (`+5 min`,
  Terminate) still applies on top.
* Context discipline (§2.2): a node prover sees ONLY its lemma + declared
  parents' signatures. The compile CONTEXT is the topological closure
  (defs real, parents sorried) — invisible to the model, free of charge.
* Negation channel (§4.3): a compiler-corroborated disproof of a node is
  registered and fed to refinement as `STATEMENT_WRONG` with the diagnosis.
* Forfeits (§4.4): a failed node must end with `## Diagnosis / ## Analysis /
  ## Suggested Fix`, which refinement consumes as decomposition proposals.
* Proof reuse (§2.3): solved nodes carry their proofs across refinement
  iterations while their signature stays byte-identical (whitespace-norm).
* Safeguards + graph validation (App. C.1): implemented in Leak XII exactly
  as listed, including the `Safeguard rejected` pre-Lean path.
* Exit condition: only Leak XIV's certificate of the fully assembled,
  attribute-stripped, sorry-free file counts — node solves and model prose
  are advisory (the house rule since the Gen-1 role-hijack incident).
