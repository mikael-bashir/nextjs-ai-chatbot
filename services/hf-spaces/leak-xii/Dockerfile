# Leak XII — lean_compile blueprint gateway (Goedel-Architect), as a REAL
# FastMCP server matching Leak-I/II's own wrapper architecture exactly
# (mcp.server.fastmcp, @mcp.tool(), mcp.sse_app() on 7860) — self-contained
# HF Space Docker build (no external `FROM`, since each Space builds
# independently from its own repo). Inlines the Lean toolchain + Mathlib +
# LeanArchitect + REPL build that services/leak-lean-base/ shares across
# services in the Oracle deploy — duplicated here on purpose (HF Space builds
# are unbilled; only runtime hardware is), so there's no registry to manage.
# See services/leak-xii/Dockerfile for the docker-compose sibling.
FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive \
    ELAN_HOME=/opt/elan \
    PATH=/opt/elan/bin:$PATH

RUN apt-get update && apt-get install -y --no-install-recommends \
      curl git ca-certificates python3 python3-pip python3-venv \
      build-essential unzip zstd \
    && rm -rf /var/lib/apt/lists/*

RUN curl -fsSL https://elan.lean-lang.org/elan-init.sh -o /tmp/elan-init.sh \
    && sh /tmp/elan-init.sh -y --default-toolchain leanprover/lean4:v4.32.0 \
    && rm /tmp/elan-init.sh \
    && lean --version

COPY gateway/ /opt/gateway/
WORKDIR /opt/gateway
RUN lake update \
    && (lake exe cache get || echo "WARN: mathlib cache unavailable — falling back to source build (slow)") \
    && lake build

RUN git clone --depth 50 https://github.com/leanprover-community/repl /opt/repl \
    && cd /opt/repl \
    && (git checkout v4.32.0 2>/dev/null || echo "leanprover/lean4:v4.32.0" > lean-toolchain) \
    && lake build \
    && ls .lake/build/bin/repl

RUN python3 -m venv /opt/venv && /opt/venv/bin/pip install --no-cache-dir \
      fastmcp nest_asyncio "uvicorn[standard]"
ENV PATH=/opt/venv/bin:$PATH

COPY shared/ /opt/shared/
COPY server.py /opt/leak-xii/server.py

ENV POOL_SIZE=1 \
    REPL_IMPORTS="import Mathlib\nimport Architect" \
    SHARED_DIR=/opt/shared

WORKDIR /opt/leak-xii
EXPOSE 7860
CMD ["python3", "server.py"]
