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

# Pull XAI_API_KEY / LEAK_SERVICE_TOKEN (and anything else) from .env.
set -a; source .env; set +a

: "${XAI_API_KEY:?XAI_API_KEY missing from .env}"
: "${LEAK_SERVICE_TOKEN:?LEAK_SERVICE_TOKEN missing from .env}"

export LEAK_XI_URL="${LEAK_XI_URL:-https://utterfool-leak-xi.hf.space}"
export LEAK_XII_URL="${LEAK_XII_URL:-https://utterfool-leak-xii.hf.space}"
export LEAK_XIV_URL="${LEAK_XIV_URL:-https://utterfool-leak-xiv.hf.space}"
export ARCHITECT_MODEL="${ARCHITECT_MODEL:-grok-4-1-fast-reasoning}"
export ARCHITECT_NODE_CONCURRENCY="${ARCHITECT_NODE_CONCURRENCY:-2}"

echo "architect bridge: model=$ARCHITECT_MODEL"
echo "  XI : $LEAK_XI_URL"
echo "  XII: $LEAK_XII_URL"
echo "  XIV: $LEAK_XIV_URL"
exec node public/local-claude-bridge.mjs
