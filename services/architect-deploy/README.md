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
VCN → Security Lists → Default Security List → Add Ingress Rules, TCP). The
VM-local firewall is handled by `bootstrap.sh`; nothing reaches the box until
*both* layers are open.

> **Scope the source CIDR.** These services compile arbitrary Lean, and Lean
> can perform IO at elaboration time — an open, unauthenticated port here is
> a remote-code-execution surface. Two defences, use both:
> 1. Set the ingress **Source CIDR to your own public IP** (`curl ifconfig.me`
>    on your laptop, then `x.x.x.x/32`) rather than `0.0.0.0/0`.
> 2. `bootstrap.sh` generates a `LEAK_SERVICE_TOKEN` into `.env` and prints
>    it; every request except `/health` must then carry
>    `Authorization: Bearer <token>`. Pass the same value to the bridge.

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
xAI API directly (no Claude CLI on this path).

**Register the three services in the app's existing MCP Servers UI** —
the same place every other Leak server lives, not a separate mechanism:
add a server per service named exactly `Leak XI`, `Leak XII`, `Leak XIV`
(case/punctuation-insensitive — `Leak-XI`, `leak_xi` also match) with its
URL. Auth type on that row doesn't matter; only the name and URL are read.
The bridge resolves each service's URL from whichever servers you've
registered for the active session, the same way `hacker`/`have-tree`/etc.
already discover Leak I/II/IV — no separate registration system to learn.

**The bearer token is the one thing that stays outside that UI, deliberately.**
This app's registered-server credentials never leave the server side —
`fetchProverMcpServers` strips `credentials` down to `{name, url}` before
anything reaches the browser or the bridge, since real MCP auth stays inside
the Python manager. XI/XII/XIV are plain REST services the bridge calls
directly from your machine, so their token has to actually reach the bridge
process — pushing it through that same channel would mean transmitting a
live secret through a client-visible request body, which is a step *backward*
from how this app already handles secrets. `LEAK_SERVICE_TOKEN` stays a
bridge-local env var, the same pattern as `XAI_API_KEY` and `ANTHROPIC_API_KEY`.

```sh
XAI_API_KEY='<your xai key>' \
LEAK_SERVICE_TOKEN='<printed by bootstrap.sh>' \
ARCHITECT_MODEL='grok-4.1-fast-reasoning' \
  node claude-bridge.mjs
```

No LEAK_XI_URL/LEAK_XII_URL/LEAK_XIV_URL needed once the servers are
registered in the UI — they're still read as a fallback (below), useful
for headless contexts with no browser session, like the queue worker.

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
