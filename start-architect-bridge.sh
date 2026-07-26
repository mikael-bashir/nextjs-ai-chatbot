#!/usr/bin/env bash
# Start the local Claude bridge with the Goedel-Architect stack wired in:
# Grok driver (XAI_API_KEY) + the three Leak Spaces on Hugging Face.
#
#   ./start-architect-bridge.sh
#
# Secrets (XAI_API_KEY, LEAK_SERVICE_TOKEN) live in .env — never in this
# script. The LEAK_*_URLs are public Space hostnames, safe to commit.
set -euo pipefail
cd "$(dirname "$0")"

# Pull XAI_API_KEY (and anything else) from .env.
set -a; source .env; set +a

: "${XAI_API_KEY:?XAI_API_KEY missing from .env}"
# LEAK_SERVICE_TOKEN is no longer required: XI/XII/XIV are now real FastMCP
# servers matching Leak-I/II's own security model exactly (an unguessable
# Space URL, no auth layer) rather than a bespoke bearer-token gate.

# Fallback only. The bridge resolves XI/XII/XIV by NAME from whatever MCP
# servers you've registered in the app's own MCP Servers UI first (register
# them as "Leak XI" / "Leak XII" / "Leak XIV" with these URLs — same place
# every other Leak server lives). These env vars only kick in if no matching
# registered server is found for the active session.
export LEAK_XI_URL="${LEAK_XI_URL:-https://utterfool-leak-xi.hf.space}"
export LEAK_XII_URL="${LEAK_XII_URL:-https://utterfool-leak-xii.hf.space}"
export LEAK_XIV_URL="${LEAK_XIV_URL:-https://utterfool-leak-xiv.hf.space}"
export ARCHITECT_MODEL="${ARCHITECT_MODEL:-grok-4-1-fast-reasoning}"
export ARCHITECT_NODE_CONCURRENCY="${ARCHITECT_NODE_CONCURRENCY:-2}"

echo "architect bridge: model=$ARCHITECT_MODEL"
echo "  (resolving Leak XI/XII/XIV by name from the app's registered MCP servers;"
echo "   env-var fallback: XI=$LEAK_XI_URL XII=$LEAK_XII_URL XIV=$LEAK_XIV_URL)"
exec node public/local-claude-bridge.mjs
