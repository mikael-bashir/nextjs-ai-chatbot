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
