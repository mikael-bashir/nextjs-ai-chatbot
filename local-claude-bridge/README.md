# Local Claude Agent — bridge

This is a tiny local server that lets the CompeteMath web app run Claude agents
on **your** machine, using **your** logged-in Claude Code (and therefore your
own subscription). Your browser talks to this bridge directly at
`http://localhost:4123` — prompts and results never touch the app's server.

> The canonical script lives at [`public/local-claude-bridge.mjs`](../public/local-claude-bridge.mjs)
> so the app can serve it for a one-command install. This folder is just docs.

## Easiest: one command from the app

Open **Local Agent → Configuration** in the app and copy the ready-made command.
It downloads this script and starts it with a token already matched to your
browser, so there's nothing to copy back. It looks like:

```sh
curl -fsSL 'https://<app-origin>/local-claude-bridge.mjs' -o claude-bridge.mjs \
  && BRIDGE_TOKEN='<generated>' ALLOWED_ORIGINS='https://<app-origin>' node claude-bridge.mjs
```

## Prerequisites

1. **Install Claude Code** and log in with your subscription:
   ```sh
   npm install -g @anthropic-ai/claude-code
   claude --version
   claude login
   ```
2. **Node.js 18+** for the bridge. No `npm install` — it uses only Node built-ins.

## Options (environment variables)

| Var | Default | Meaning |
|-----|---------|---------|
| `PORT` | `4123` | Port to listen on (loopback only). |
| `BRIDGE_TOKEN` | random | Fixed token instead of a new one each start. The app sets this for you. |
| `CLAUDE_BIN` | `claude` | Path to the Claude Code binary. |
| `ALLOWED_ORIGINS` | competemath origins | Comma-separated app origins allowed to call the bridge. |

Windows PowerShell download alternative:
```powershell
irm 'https://<app-origin>/local-claude-bridge.mjs' -OutFile claude-bridge.mjs
$env:BRIDGE_TOKEN='<generated>'; $env:ALLOWED_ORIGINS='https://<app-origin>'; node claude-bridge.mjs
```

## Worker mode — drain the Leak API queue

The same script can act as a **worker** for the Leak API service: it leases
queued problems from the app, proves each one with the *same* `runProve()` that
backs `/prove`, heartbeats while proving, and posts the result back. Set two env
vars and it starts a poll loop alongside (or instead of) the HTTP server:

```sh
WORKER_URL='https://leak.competemath.com' \
WORKER_SECRET='<LEAK_WORKER_SECRET from the app env>' \
  node claude-bridge.mjs
```

| Var | Default | Meaning |
|-----|---------|---------|
| `WORKER_URL` | — | App origin. Set (with `WORKER_SECRET`) to enable worker mode. |
| `WORKER_SECRET` | — | Must equal the app's `LEAK_WORKER_SECRET`. |
| `WORKER_ID` | `bridge-<pid>` | Label recorded on leased jobs. |
| `WORKER_POLL_MS` | `5000` | How often to poll when the queue is empty. |
| `WORKER_MODEL` | CLI default | e.g. `claude-opus-4-8`; empty = your Max plan default. |
| `WORKER_MCP_CONFIG` | `[]` | Fallback prover MCP servers (`{name,url}`) if the lease response doesn't carry them. Normally the app supplies the hard-set Leak_I/Leak_II servers on each lease, so you don't set this. |

It reuses the app's worker data-plane: `POST /api/worker/lease`,
`/api/worker/heartbeat`, `/api/worker/complete`. Runs happily in the same
process as the loopback server (both, one, or neither activate based on which
env vars you set). A crashed/closed worker's in-flight job auto-requeues once its
lease expires, so it's safe to just Ctrl-C.

## Security

- Binds to `127.0.0.1` only — not reachable from your network.
- Every request requires the secret token (keep it private — anyone with it can
  drive your Claude). This is why the token exists: without it, any website you
  visit could call `http://localhost:4123` and run agents on your machine.
- Only the specific app origins are allowed (CORS), plus `localhost`.
- Accepts only a fixed, validated set of run options — it will **not** run an
  arbitrary binary or arbitrary CLI flags sent by the page.

## Browser compatibility

- **Chrome / Edge / Firefox:** works. Chrome may show a one-time Private Network
  Access prompt — allow it.
- **Safari:** blocks HTTPS pages from calling `http://localhost`. Use Chrome,
  Edge, or Firefox for this feature.

## Endpoints (for reference)

- `GET /health` → `{ ok, version }` — reachability + `claude --version`.
- `POST /run` `{ prompt, options }` → `{ ok, text, exitCode, durationMs, timedOut, stderr }`.

Both require header `x-bridge-token: <token>`.
