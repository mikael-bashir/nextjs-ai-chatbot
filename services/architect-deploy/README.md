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

### Instance settings that matter

| Setting | Value | Why |
|---|---|---|
| Shape | `VM.Standard.A1.Flex`, **2 OCPU / 12 GB** | Both sliders matter: the free ceiling is 2 OCPUs *and* 12 GB. One Mathlib daemon wants 4–6 GB, and Lean builds are CPU-bound, so 1 OCPU roughly doubles every compile. |
| Image | Ubuntu 24.04 (incl. **Minimal**) or Oracle Linux 9, aarch64 | `bootstrap.sh` detects the distro and installs what Minimal omits (git, iptables-persistent). |
| Boot volume | **100–150 GB** (default is 50) | Mathlib cache + Docker layers. Always Free covers 200 GB total. |
| Capacity type | **On-demand** | Preemptible instances get reclaimed mid-proof. |
| Public IPv4 | assign | The bridge talks to the box over the internet. |

Save the SSH private key at creation time — OCI will not show it again.

```sh
git clone <this repo> leak && cd leak/services/architect-deploy
bash bootstrap.sh
```

First build ≈ 30–60 min (Mathlib olean cache download + LeanArchitect + REPL
compile). Defaults are tuned for the 12 GB shape: one warm daemon in XII, a
lazy one in XIV, 8 GB swap. On a bigger PAYG shape set `XII_POOL_SIZE=2`–`3`
and raise `ARCHITECT_NODE_CONCURRENCY` on the bridge to match.

**Also open ports 8011/8012/8014 in the subnet Security List** (OCI console →
VCN → Security Lists → Ingress, source `0.0.0.0/0`, TCP). The VM-local
firewall (iptables or firewalld) is handled by `bootstrap.sh`. Nothing
reaches the box until *both* are open.

### Known Oracle gotchas

* **"Out of host capacity"** on A1 is common and is not your fault — retry
  across AD 1/2/3, or retry on a loop. Upgrading the tenancy to
  pay-as-you-go keeps Always Free resources free while making A1 capacity
  far easier to get.
* **Idle reclamation** applies to Always Free A1 instances that stay under
  ~20% CPU *and* network *and* memory for 7 days. A warm Lean daemon holds
  several GB resident, which keeps memory well above that line — but if you
  stop the stack for a week, the instance can be reclaimed. PAYG tenancies
  are exempt.

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
