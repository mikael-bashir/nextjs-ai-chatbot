# Leak — an agentic theorem-proving stack for Lean 4

Leak is the automated theorem prover behind [competemath.com](https://www.competemath.com) - it produces **formal, machine-checked Lean 4 + Mathlib proofs** for competition problems, and it is what generates the proofs for the 200+ problems on [competemath.com/practice](https://www.competemath.com/practice).

On **FATE-X** (a 100-problem benchmark whose difficulty exceeds PhD-qualifying exams), Leak's best prover scores **38%**, ahead of the current state-of-the-art (Leanstral 1.5, 34%).

The core design finding: driving the pipeline with a frontier **agent** (Claude Sonnet 5's CLI) rather than a raw LLM inverts a lot of the received wisdom - the awesome decomposition scaffolding in recent papers (e.g. Goedel-Architect's DeepSeek-V4-Flash blueprint pipeline) *degrades* performance when the driver is already an agent, as might be expected from scaffolding too complex. A simpler design that hands the agent **context-rich tools** - library search, a compiler, and an interactive proof assistant - beats it outright. That simpler design is what runs today. It should be clear that this insight only applies when studying **agent-driven** pipelines, as opposed to **llm-driven** pipelines, like the Goedel-Architect prover.

The app was intended as a commercial project, thus it is mostly **unusable locally** - if you are interested in the proving logic, we highly suggest checking out the file here: https://github.com/mikael-bashir/nextjs-ai-chatbot/blob/main/public/local-claude-bridge.mjs. Truly, this file is huge, and wasn't developed with maintenance in mind - we highly encourage use of AI tools to interpret and modularise this file. You will have to develop your own UI to interact with the harness, or modify the Leak repo to not break locally.

---

## Architecture

Four pieces cooperate:

| Piece | What it is | Runs on |
|---|---|---|
| **Dashboard** (this repo) | Next.js app: benchmark console, prover playground, research views, the competemath surfaces | Your machine / any Node host (`:3000`) |
| **Python service** (`app/api/index.py`) | Quart backend: the MCP connection manager that proxies the agent to the verifier services | Your machine (`:5328`) |
| **Local bridge** (`public/local-claude-bridge.mjs`) | Spawns the `claude` CLI, streams its tool calls, and enforces the independent proof gate | Your machine (Node) |
| **remote MCP services** | The Lean verification / search / interaction tools the agent calls (see below) | Hugging Face Docker Spaces (fork-and-deploy) |

The agent never self-reports success: every proof is re-verified by an independent Leak IV/XIV compile of the submitted script, so soundness is the toolchain's, not the model's.

## The MCP services

All six are collected under the [**`leak-services`**](https://github.com/mikael-bashir/leak-services) umbrella repo (each its own repo, mirrored from its Hugging Face Space). Two verifier **groups**, pinned to different toolchains:

| Service | Group | Role | Toolchain | Source |
|---|---|---|---|---|
| **Leak I** | 4.29.1 | Loogle / Moogle library search | Lean 4.29.1 | [`leak-i`](https://github.com/mikael-bashir/leak-i) |
| **Leak II** | 4.29.1 | Pantograph — interactive `init_proof`/`apply_tactic` (ghost-daemon snapshot layer) | Lean 4.29.1 | [`leak-ii`](https://github.com/mikael-bashir/leak-ii) |
| **Leak IV** | 4.29.1 | `verify_full_script` — the whole-script compile gate | Lean 4.29.1 | [`leak-iv`](https://github.com/mikael-bashir/leak-iv) |
| **Leak XI** | 4.32.0 | Loogle / Moogle search (architect group) | Lean 4.32.0 | [`leak-xi`](https://github.com/mikael-bashir/leak-xi) |
| **Leak XII** | 4.32.0 | `lean_compile` — compile + elaborate blueprints, `#eval` readback | Lean 4.32.0 | [`leak-xii`](https://github.com/mikael-bashir/leak-xii) |
| **Leak XIV** | 4.32.0 | `verify_full_script` for the architect group | Lean 4.32.0 | [`leak-xiv`](https://github.com/mikael-bashir/leak-xiv) |

> The Leak I/II/IV group gates the flat control arms; the XI/XII/XIV group serves the decomposition (architect) pipeline. A run only ever uses one group.

Each service is a self-contained **Docker** app (`Dockerfile` + `server.py`) exposing an unsecure MCP endpoint over SSE. We recommend you add authentication layers if hosting the services publically, and if required authorization.

### Forking / deploying a service

The services are published as Hugging Face **Docker Spaces**. To run your own:

1. Open the service's Space (or its repo) and **"Duplicate this Space"** (Hugging Face copies the Dockerfile + code into your account), *or* clone the source and deploy the `Dockerfile` on any Docker host.
2. Set any Space secrets the service needs (none are committed — check the `Dockerfile`/`server.py`).
3. Wait for the Space to build (Lean + Mathlib cold-builds take a while).
4. Copy the running URL (`https://<you>-<space>.hf.space`) and register it in the app's **MCP connection manager** (in-app, on the dashboard). The prover picks up whatever verifier group you connect.

---

## Repo layout

- `app/`, `components/`, `lib/` — the Next.js dashboard (benchmark console, playground, research, competemath surfaces)
- `app/api/index.py` — the Quart MCP connection-manager service
- `public/local-claude-bridge.mjs` — the agent bridge + independent proof gate + all prover strategies
- `lib/prover/strategies.ts` — the strategy catalogue (architect pipelines, Stronghold family, controls)
- `services/` — Dockerised service sources (`leak-xi`, `leak-xii`, `leak-xiv`, worker, cost-estimator)

## Related

- Benchmark records & proofs: [competemath/LRR](https://github.com/competemath/LRR)

## License / provenance

The dashboard began as a fork of the Vercel [Chat SDK](https://chat-sdk.dev) template; the Leak prover stack, MCP services, bridge, and benchmark infrastructure are original work.
