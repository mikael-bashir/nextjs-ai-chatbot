"""Central config, all overridable by environment variable.

The service is meant to be self-hosted next to the Leak verifier (same box as the
existing python-backend), so every knob has a sane default and needs no config to
boot in dev.
"""
from __future__ import annotations

import os
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def _int(name: str, default: int) -> int:
    try:
        return int(os.environ.get(name, default))
    except (TypeError, ValueError):
        return default


def _float(name: str, default: float) -> float:
    try:
        return float(os.environ.get(name, default))
    except (TypeError, ValueError):
        return default


# ── storage ──────────────────────────────────────────────────────────────────
DB_PATH = Path(os.environ.get("EST_DB_PATH", ROOT / "data" / "runs.db"))
MODEL_DIR = Path(os.environ.get("EST_MODEL_DIR", ROOT / "models"))

# ── embeddings ───────────────────────────────────────────────────────────────
# A local sentence-transformer. If the package/model isn't present the embedder
# transparently falls back to a deterministic hashing embedding (see embed.py),
# so the whole pipeline runs with zero heavy dependencies until you opt in.
EMBED_MODEL = os.environ.get("EST_EMBED_MODEL", "sentence-transformers/all-MiniLM-L6-v2")
EMBED_DIM = _int("EST_EMBED_DIM", 384)  # fallback hashing dim; real model sets its own
EMBED_ENABLED = os.environ.get("EST_EMBED_ENABLED", "1") not in ("0", "false", "")

# ── model / prediction ───────────────────────────────────────────────────────
# Quantiles trained for the cost regressor: point estimate + a safe upper one.
COST_Q_POINT = _float("EST_COST_Q_POINT", 0.5)
COST_Q_SAFE = _float("EST_COST_Q_SAFE", 0.8)
# Below this many labelled rows we don't trust a learned model and fall back to a
# robust global prior (median cost, high prove-prob). Keeps predictions sane cold.
MIN_TRAIN_ROWS = _int("EST_MIN_TRAIN_ROWS", 25)
COST_FLOOR_USD = _float("EST_COST_FLOOR_USD", 0.08)  # fixed proof overhead

# ── reject gate (production) ─────────────────────────────────────────────────
# Reject a problem if its SAFE cost exceeds the budget OR its prove-probability is
# below the floor. Both are per-request overridable.
DEFAULT_BUDGET_USD = _float("EST_DEFAULT_BUDGET_USD", 5.0)
DEFAULT_MIN_PROVE_PROB = _float("EST_DEFAULT_MIN_PROVE_PROB", 0.25)
