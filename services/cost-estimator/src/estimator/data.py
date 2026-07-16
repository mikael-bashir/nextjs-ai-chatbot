"""SQLite store of labelled verifier runs — the estimator's growing training set.

One row per proof attempt the Leak verifier finishes. The signature is the raw
Lean theorem (production input); the label is the realised cost + whether it was
proved + how long it took. Structural features and the embedding are computed and
cached at ingest so retraining never recomputes them.

SQLite is deliberate: single file, zero-ops, plenty fast for the thousands of
rows this will ever hold, and trivially backed up. Point EST_DB_PATH at a mounted
volume in production so the dataset survives redeploys.
"""
from __future__ import annotations

import json
import sqlite3
import time
from typing import Any, Dict, List, Optional

import numpy as np

from . import config, embed
from .features import extract_features

_SCHEMA = """
CREATE TABLE IF NOT EXISTS runs (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    ts             REAL NOT NULL,
    signature      TEXT NOT NULL,
    proved         INTEGER NOT NULL,           -- 1 proved, 0 failed/too-hard
    actual_cost_usd REAL,                       -- NULL if unknown / not measured
    wall_ms        INTEGER,
    model          TEXT,
    source         TEXT,                        -- 'verifier' | 'seed' | 'manual'
    features_json  TEXT NOT NULL,
    embedding      BLOB NOT NULL,               -- float32 npy bytes
    embed_kind     TEXT NOT NULL,
    sig_hash       TEXT                         -- dedupe key
);
CREATE INDEX IF NOT EXISTS idx_runs_sig ON runs(sig_hash);
CREATE INDEX IF NOT EXISTS idx_runs_proved ON runs(proved);
"""


def _conn() -> sqlite3.Connection:
    config.DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    c = sqlite3.connect(str(config.DB_PATH))
    c.row_factory = sqlite3.Row
    return c


def init_db() -> None:
    with _conn() as c:
        c.executescript(_SCHEMA)


def _sig_hash(sig: str) -> str:
    import hashlib

    return hashlib.sha1((sig or "").strip().encode()).hexdigest()


def ingest(
    signature: str,
    proved: bool,
    actual_cost_usd: Optional[float] = None,
    wall_ms: Optional[int] = None,
    model: Optional[str] = None,
    source: str = "verifier",
    dedupe: bool = True,
) -> int:
    """Store one labelled run. Returns the new row id (or the existing id if a
    dedupe hit and nothing better was supplied)."""
    init_db()
    sig = (signature or "").strip()
    if not sig:
        raise ValueError("signature is required")
    sh = _sig_hash(sig)
    feats = extract_features(sig)
    emb = embed.embed_one(sig).astype("float32")
    info = embed.embedder_info()

    with _conn() as c:
        if dedupe:
            row = c.execute(
                "SELECT id, actual_cost_usd FROM runs WHERE sig_hash=? ORDER BY id DESC LIMIT 1",
                (sh,),
            ).fetchone()
            if row is not None:
                # Upgrade a prior row that lacked a cost if we now have one.
                if row["actual_cost_usd"] is None and actual_cost_usd is not None:
                    c.execute(
                        "UPDATE runs SET actual_cost_usd=?, proved=?, wall_ms=?, ts=? WHERE id=?",
                        (actual_cost_usd, int(proved), wall_ms, time.time(), row["id"]),
                    )
                return int(row["id"])
        cur = c.execute(
            """INSERT INTO runs
               (ts, signature, proved, actual_cost_usd, wall_ms, model, source,
                features_json, embedding, embed_kind, sig_hash)
               VALUES (?,?,?,?,?,?,?,?,?,?,?)""",
            (
                time.time(), sig, int(proved), actual_cost_usd, wall_ms, model, source,
                json.dumps(feats), emb.tobytes(), info["kind"], sh,
            ),
        )
        return int(cur.lastrowid)


def fetch_all() -> List[Dict[str, Any]]:
    init_db()
    with _conn() as c:
        rows = c.execute("SELECT * FROM runs ORDER BY id ASC").fetchall()
    out = []
    for r in rows:
        out.append(
            {
                "id": r["id"],
                "signature": r["signature"],
                "proved": bool(r["proved"]),
                "actual_cost_usd": r["actual_cost_usd"],
                "wall_ms": r["wall_ms"],
                "features": json.loads(r["features_json"]),
                "embedding": np.frombuffer(r["embedding"], dtype="float32"),
                "embed_kind": r["embed_kind"],
            }
        )
    return out


def stats() -> Dict[str, Any]:
    init_db()
    with _conn() as c:
        n = c.execute("SELECT COUNT(*) AS n FROM runs").fetchone()["n"]
        n_cost = c.execute(
            "SELECT COUNT(*) AS n FROM runs WHERE actual_cost_usd IS NOT NULL"
        ).fetchone()["n"]
        n_proved = c.execute("SELECT COUNT(*) AS n FROM runs WHERE proved=1").fetchone()["n"]
    return {"rows": int(n), "with_cost": int(n_cost), "proved": int(n_proved),
            "failed": int(n) - int(n_proved)}
