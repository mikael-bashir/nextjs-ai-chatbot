# Leak XIV — assembly verifier (certification gate), self-contained HF Space
# build. See services/hf-spaces/leak-xii/Dockerfile for why the base build is
# inlined rather than shared via `FROM`.
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
      fastapi==0.115.* "uvicorn[standard]"==0.30.*
ENV PATH=/opt/venv/bin:$PATH

COPY shared/ /opt/shared/
COPY server.py /opt/leak-xiv/server.py

# Lazy single daemon: warms on first /verify, reaped after 15 min idle. On
# HF Spaces this mostly just saves RAM within the Space's own hardware
# allocation — the Space-level sleep timer (below) is what actually stops
# billing, independent of this internal daemon lazily napping.
ENV POOL_SIZE=1 \
    LAZY=1 \
    REPL_IMPORTS="import Mathlib" \
    SHARED_DIR=/opt/shared \
    PORT=8014

WORKDIR /opt
EXPOSE 8014
CMD ["sh", "-c", "uvicorn server:app --app-dir /opt/leak-xiv --host 0.0.0.0 --port ${PORT}"]
