# ---------------------------------------------------------------------------
# leak-lean-base — shared base image for Leak XII (lean_compile gateway) and
# Leak XIV (assembly verifier).
#
# Contents:
#   * elan + Lean leanprover/lean4:v4.32.0 (LeanArchitect's pinned toolchain)
#   * /opt/gateway  — Lake project with Mathlib v4.32.0 + LeanArchitect built
#   * /opt/repl     — leanprover-community/repl binary for the same toolchain
#   * python3 + fastapi/uvicorn for the HTTP servers layered on top
#
# Build natively on the target arch (Oracle A1 = linux/arm64). Mathlib's
# `lake exe cache get` serves portable .olean files, so no source rebuild is
# needed on aarch64; the from-source fallback works but takes hours.
# ---------------------------------------------------------------------------
FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive \
    ELAN_HOME=/opt/elan \
    PATH=/opt/elan/bin:$PATH

RUN apt-get update && apt-get install -y --no-install-recommends \
      curl git ca-certificates python3 python3-pip python3-venv \
      build-essential unzip zstd \
    && rm -rf /var/lib/apt/lists/*

# elan (Lean version manager); pin the toolchain non-interactively.
RUN curl -fsSL https://elan.lean-lang.org/elan-init.sh -o /tmp/elan-init.sh \
    && sh /tmp/elan-init.sh -y --default-toolchain leanprover/lean4:v4.32.0 \
    && rm /tmp/elan-init.sh \
    && lean --version

# ---- Gateway project: Mathlib + LeanArchitect on one LEAN_PATH -------------
COPY gateway/ /opt/gateway/
WORKDIR /opt/gateway
# cache get downloads prebuilt Mathlib oleans (portable across arch);
# lake build then compiles only LeanArchitect + Gateway.lean (minutes).
RUN lake update \
    && (lake exe cache get || echo "WARN: mathlib cache unavailable — falling back to source build (slow)") \
    && lake build

# ---- REPL: machine interface used by the daemon pool -----------------------
# The repl repo tags releases per toolchain; if the exact tag is missing we
# take master and force our toolchain (the repl is small and stable).
RUN git clone --depth 50 https://github.com/leanprover-community/repl /opt/repl \
    && cd /opt/repl \
    && (git checkout v4.32.0 2>/dev/null || echo "leanprover/lean4:v4.32.0" > lean-toolchain) \
    && lake build \
    && ls .lake/build/bin/repl

# ---- Python runtime for the HTTP layer --------------------------------------
RUN python3 -m venv /opt/venv && /opt/venv/bin/pip install --no-cache-dir \
      fastapi==0.115.* "uvicorn[standard]"==0.30.*
ENV PATH=/opt/venv/bin:$PATH

# Shared modules (REPL pool, blueprint parser/validators) used by XII and XIV.
COPY shared/ /opt/shared/

WORKDIR /opt
