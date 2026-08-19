# Leak — an agentic theorem-proving stack for Lean 4

Leak is the automated theorem prover behind [competemath.com](https://www.competemath.com) — it produces **formal, machine-checked Lean 4 + Mathlib proofs** for competition problems, and it is what generates the proofs for the 200+ problems on [competemath.com/practice](https://www.competemath.com/practice).

On **FATE-X** (a 100-problem benchmark whose difficulty exceeds PhD-qualifying exams), Leak's prover scores **38%**, ahead of the published state-of-the-art (Leanstral 1.5, 34%).

The core design finding: driving the pipeline with a frontier **agent** (Claude Sonnet 5's CLI) rather than a raw LLM inverts a lot of the received wisdom — the fashionable decomposition scaffolding in recent papers (e.g. Goedel-Architect's DeepSeek-V4-Flash blueprint pipeline) *degrades* performance when the driver is already an agent. A simpler design that hands the agent **context-rich tools** — library search, a compiler, and an interactive proof assistant — beats it outright. That simpler design is what runs today.

---

## Architecture

Four pieces cooperate:

| Piece | What it is | Runs on |
|---|---|---|
| **Dashboard** (this repo) | Next.js app: benchmark console, prover playground, research views, the competemath surfaces | Your machine / any Node host (`:3000`) |
| **Python service** (`app/api/index.py`) | Quart backend: the MCP connection manager that proxies the agent to the verifier services | Your machine (`:5328`) |
| **Local bridge** (`public/local-claude-bridge.mjs`) | Spawns the `claude` CLI, streams its tool calls, and enforces the independent proof gate | Your machine (Node) |
| **6 remote MCP services** | The Lean verification / search / interaction tools the agent calls (see below) | Hugging Face Docker Spaces (fork-and-deploy) |

The agent never self-reports success: every proof is re-verified by an independent Leak IV/XIV compile of the submitted script, so soundness is the toolchain's, not the model's.

## The 6 MCP services

Two verifier **groups**, pinned to different toolchains:

| Service | Group | Role | Toolchain | Source |
|---|---|---|---|---|
| **Leak I** | 4.29.1 | Loogle / Moogle library search | Lean 4.29.1 | [`leak-i`](https://github.com/mikael-bashir/leak-i) |
| **Leak II** | 4.29.1 | Pantograph — interactive `init_proof`/`apply_tactic` (ghost-daemon snapshot layer) | Lean 4.29.1 | [`leak-ii`](https://github.com/mikael-bashir/leak-ii) |
| **Leak IV** | 4.29.1 | `verify_full_script` — the whole-script compile gate | Lean 4.29.1 | HF Space `BarkingTree/Leak-IV` |
| **Leak XI** | 4.32.0 | Loogle / Moogle search (architect group) | Lean 4.32.0 | `services/leak-xi` |
| **Leak XII** | 4.32.0 | `lean_compile` — compile + elaborate blueprints, `#eval` readback | Lean 4.32.0 | HF Space `utterfool/Leak-XII` |
| **Leak XIV** | 4.32.0 | `verify_full_script` for the architect group | Lean 4.32.0 | `services/leak-xiv` |

> The Leak I/II/IV group gates the flat control arms; the XI/XII/XIV group serves the decomposition (architect) pipeline. A run only ever uses one group.

Each service is a self-contained **Docker** app (`Dockerfile` + `server.py`) exposing an MCP endpoint over SSE.

### Forking / deploying a service

The services are published as Hugging Face **Docker Spaces**. To run your own:

1. Open the service's Space (or its repo) and **"Duplicate this Space"** (Hugging Face copies the Dockerfile + code into your account), *or* clone the source and deploy the `Dockerfile` on any Docker host.
2. Set any Space secrets the service needs (none are committed — check the `Dockerfile`/`server.py`).
3. Wait for the Space to build (Lean + Mathlib cold-builds take a while).
4. Copy the running URL (`https://<you>-<space>.hf.space`) and register it in the app's **MCP connection manager** (in-app, on the dashboard). The prover picks up whatever verifier group you connect.

---

## Running locally

### Prerequisites

- **Node 18+** and **pnpm** (repo uses a pnpm lockfile; `npm` works too)
- **Python 3.11+** (for the Quart service)
- **Redis** (the Python service uses it for session state)
- A **Postgres** database (Neon serverless recommended)
- The **`claude` CLI** installed and authenticated (the bridge spawns it)

### 1. Environment

```bash
cp .env.example .env
```

Fill in `.env`:

| Var | What |
|---|---|
| `POSTGRES_URL` | Postgres / Neon connection string |
| `AUTH_SECRET` | any random 32-byte secret (`openssl rand -base64 32`) |
| `AUTH_URL` | the app's own origin, e.g. `http://localhost:3000` — **must match the port you run on**, or sign-in redirects break |
| `XAI_API_KEY` | xAI key (used by the base chat model / Grok driver) |
| `BLOB_READ_WRITE_TOKEN` | Vercel Blob token (file storage) |
| `REDIS_URL` | e.g. `redis://localhost:6379` (Python service) |

### 2. Install + migrate the database

```bash
pnpm install && pnpm tsx lib/db/migrate
```

### 3. Run the three local processes (three terminals)

**Python service (`:5328`)** — its exact run command is in `app/api/index.py`:

```bash
python3 -m venv .venv && source .venv/bin/activate && pip install -r requirements.txt && hypercorn app.api.index:app --bind 0.0.0.0:5328 --reload
```

**Dashboard (`:3000`)**:

```bash
pnpm dev
```

**Local bridge** (drives the `claude` CLI; needed to actually run proofs):

```bash
node public/local-claude-bridge.mjs
```

### 4. Connect the services

Open the dashboard, go to the **MCP connection manager**, and connect the Leak service group you want (I/II/IV for the flat controls, XI/XII/XIV for the architect pipeline). Then head to the **prover playground** or the **benchmark console** and run.

---

## Repo layout

- `app/`, `components/`, `lib/` — the Next.js dashboard (benchmark console, playground, research, competemath surfaces)
- `app/api/index.py` — the Quart MCP connection-manager service
- `public/local-claude-bridge.mjs` — the agent bridge + independent proof gate + all prover strategies
- `lib/prover/strategies.ts` — the strategy catalogue (architect pipelines, Stronghold family, controls)
- `services/` — Dockerised service sources (`leak-xi`, `leak-xii`, `leak-xiv`, worker, cost-estimator)

## Related

- Benchmark records & proofs: [competemath/LRR](https://github.com/competemath/LRR)
- Write-up: the FATE-X capability report (in the whitepaper).

## License / provenance

The dashboard began as a fork of the Vercel [Chat SDK](https://chat-sdk.dev) template; the Leak prover stack, MCP services, bridge, and benchmark infrastructure are original work.
