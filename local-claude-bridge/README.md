# Local Claude Agent — bridge

This is a tiny local server that lets the CompeteMath web app run Claude agents
on **your** machine, using **your** logged-in Claude Code (and therefore your
own subscription). Your browser talks to this bridge directly at
`http://localhost:4123` — prompts and results never touch the app's server.

## Prerequisites

1. **Install Claude Code** and verify it:
   ```sh
   npm install -g @anthropic-ai/claude-code
   claude --version
   ```
2. **Log in** with your subscription:
   ```sh
   claude login
   ```
3. **Node.js 18+** (for the bridge itself). No `npm install` needed — the bridge
   uses only Node built-ins.

## Run the bridge

```sh
node bridge.mjs
```

On startup it prints a **URL** and a **Token**. Paste both into the app under
**Local Agent → Configuration → Connection**. Keep the terminal open while you
use the feature.

### Options (environment variables)

| Var | Default | Meaning |
|-----|---------|---------|
| `PORT` | `4123` | Port to listen on (loopback only). |
| `BRIDGE_TOKEN` | random | Fixed token instead of a new one each start. |
| `CLAUDE_BIN` | `claude` | Path to the Claude Code binary. |
| `ALLOWED_ORIGINS` | competemath origins | Comma-separated app origins allowed to call the bridge. |

Example with a stable token and an explicit binary:
```sh
BRIDGE_TOKEN=my-long-secret CLAUDE_BIN="$(which claude)" node bridge.mjs
```

## Security

- Binds to `127.0.0.1` only — not reachable from your network.
- Every request requires the secret token (keep it private — anyone with it can
  drive your Claude).
- Only the specific app origins above are allowed (CORS), plus `localhost`.
- Accepts only a fixed, validated set of run options. It will **not** run an
  arbitrary binary or arbitrary CLI flags sent by the page.

## Browser compatibility

The app is served over HTTPS and calls `http://localhost:4123`.

- **Chrome / Edge / Firefox:** works. Chrome may show a one-time Private Network
  Access prompt — allow it.
- **Safari:** blocks HTTPS pages from calling `http://localhost`. Use Chrome,
  Edge, or Firefox for this feature.

## Endpoints (for reference)

- `GET /health` → `{ ok, version }` — reachability + `claude --version`.
- `POST /run` `{ prompt, options }` → `{ ok, text, exitCode, durationMs, timedOut, stderr }`.

Both require header `x-bridge-token: <token>`.
