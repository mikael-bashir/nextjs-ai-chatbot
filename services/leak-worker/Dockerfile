# Hosted Claude Agent SDK prover. Debian (glibc) base so the SDK's bundled
# native Claude Code binary (@anthropic-ai/claude-agent-sdk-linux-x64, an
# optional dependency) installs and runs — do NOT use alpine/musl here.
FROM node:20-slim

# git + ripgrep + ca-certificates: the bundled agent runtime expects them, and
# ca-certificates is needed for TLS to the Anthropic API and the MCP servers.
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates git ripgrep \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /worker

# Install deps first for layer caching. The SDK pulls its platform binary as an
# optional dependency, so keep them (do NOT pass --no-optional).
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund

COPY hosted-agent-worker.mjs ./

# This image IS the hosted worker.
ENV WORKER_KIND=hosted

CMD ["node", "hosted-agent-worker.mjs"]
