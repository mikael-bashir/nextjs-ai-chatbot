"""The learned estimator: cost (quantile regression) + provability (classifier).

Feature vector = [ structural fingerprint  ‖  local semantic embedding ].
  • cost      → two gradient-boosted quantile regressors on log-cost: a point
                estimate (q=0.5) and a SAFE upper estimate (q=0.8, used by the
                reject gate and for budgeting).
  • provable  → gradient-boosted classifier → P(proved). Its negatives are the
                failed/too-hard runs the verifier logs over time.

Everything degrades gracefully: under MIN_TRAIN_ROWS labelled rows, or with only
one provability class, it falls back to a robust global prior instead of a
nonsense fit — so the service is useful from row 1 and gets sharper with data.

Trains in well under a second on thousands of rows; inference is a single vector
build + a couple of tree evaluations (embedding is the only real latency, and
the local model is milliseconds) — comfortably inside the 3-second budget.
"""
from __future__ import annotations

import json
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Dict, List, Optional

import numpy as np

from . import config, embed
from .features import FEATURE_NAMES, feature_vector

_ARTIFACT = "estimator.joblib"


def _matrix(signatures: List[str]) -> np.ndarray:
    """[structural ‖ embedding] for a batch, recomputed with the CURRENT embedder
    so switching embedding models is just a retrain away."""
    struct = np.vstack([feature_vector(s) for s in signatures]).astype("float32")
    emb = embed.embed_many(signatures).astype("float32")
    return np.hstack([struct, emb])


@dataclass
class Meta:
    n_rows: int = 0
    n_cost: int = 0
    prove_rate: float = 1.0
    global_median_cost: float = config.COST_FLOOR_USD
    embed: Dict[str, Any] = field(default_factory=dict)
    cv_mape: Optional[float] = None
    trained_at: float = 0.0
    prior_mode_cost: bool = True
    prior_mode_prove: bool = True
    version: int = 1


class Estimator:
    def __init__(self):
        self.cost_point = None
        self.cost_safe = None
        self.clf = None
        self.meta = Meta(embed=embed.embedder_info())

    # ── training ────────────────────────────────────────────────────────────
    def train(self, rows: List[Dict[str, Any]]) -> Meta:
        from sklearn.ensemble import (
            HistGradientBoostingClassifier,
            HistGradientBoostingRegressor,
        )

        meta = Meta(embed=embed.embedder_info(), trained_at=time.time())
        meta.n_rows = len(rows)

        cost_rows = [r for r in rows if r.get("actual_cost_usd") is not None]
        meta.n_cost = len(cost_rows)
        proved = [1 if r["proved"] else 0 for r in rows]
        meta.prove_rate = float(np.mean(proved)) if proved else 1.0
        if cost_rows:
            meta.global_median_cost = float(
                np.median([r["actual_cost_usd"] for r in cost_rows])
            )

        # Cost regressors (need enough labelled rows to be trustworthy).
        if meta.n_cost >= config.MIN_TRAIN_ROWS:
            Xc = _matrix([r["signature"] for r in cost_rows])
            yc = np.log1p([max(config.COST_FLOOR_USD, r["actual_cost_usd"]) for r in cost_rows])
            self.cost_point = HistGradientBoostingRegressor(
                loss="quantile", quantile=config.COST_Q_POINT, max_iter=300,
                learning_rate=0.05, max_depth=3, min_samples_leaf=5,
            ).fit(Xc, yc)
            self.cost_safe = HistGradientBoostingRegressor(
                loss="quantile", quantile=config.COST_Q_SAFE, max_iter=300,
                learning_rate=0.05, max_depth=3, min_samples_leaf=5,
            ).fit(Xc, yc)
            meta.prior_mode_cost = False
            meta.cv_mape = self._cv_mape(Xc, yc)
        else:
            self.cost_point = self.cost_safe = None
            meta.prior_mode_cost = True

        # Provability classifier (needs both classes).
        if len(set(proved)) >= 2 and len(rows) >= config.MIN_TRAIN_ROWS:
            Xp = _matrix([r["signature"] for r in rows])
            self.clf = HistGradientBoostingClassifier(
                max_iter=300, learning_rate=0.05, max_depth=3, min_samples_leaf=5,
            ).fit(Xp, np.array(proved))
            meta.prior_mode_prove = False
        else:
            self.clf = None
            meta.prior_mode_prove = True

        self.meta = meta
        return meta

    def _cv_mape(self, X: np.ndarray, y_log: np.ndarray) -> Optional[float]:
        from sklearn.ensemble import HistGradientBoostingRegressor
        from sklearn.model_selection import KFold

        n = len(y_log)
        if n < 10:
            return None
        actual = np.expm1(y_log)
        errs: List[float] = []
        for tr, te in KFold(n_splits=min(5, n), shuffle=True, random_state=0).split(X):
            m = HistGradientBoostingRegressor(
                loss="quantile", quantile=config.COST_Q_POINT, max_iter=300,
                learning_rate=0.05, max_depth=3, min_samples_leaf=5,
            ).fit(X[tr], y_log[tr])
            pred = np.expm1(m.predict(X[te]))
            errs.extend(np.abs(pred - actual[te]) / np.maximum(actual[te], 1e-9))
        return float(np.mean(errs))

    # ── prediction ──────────────────────────────────────────────────────────
    def predict(self, signature: str) -> Dict[str, Any]:
        x = _matrix([signature])
        if self.meta.prior_mode_cost or self.cost_point is None:
            point = safe = max(config.COST_FLOOR_USD, self.meta.global_median_cost)
        else:
            point = float(np.expm1(self.cost_point.predict(x))[0])
            safe = float(np.expm1(self.cost_safe.predict(x))[0])
        point = max(config.COST_FLOOR_USD, round(point, 4))
        safe = max(point, round(safe, 4))

        if self.meta.prior_mode_prove or self.clf is None:
            prove_prob = float(self.meta.prove_rate)
        else:
            prove_prob = float(self.clf.predict_proba(x)[0, 1])
        return {
            "est_cost_usd": point,
            "safe_cost_usd": safe,
            "prove_prob": round(prove_prob, 4),
            "prior_mode": self.meta.prior_mode_cost,
        }

    # ── persistence ─────────────────────────────────────────────────────────
    def save(self, model_dir: Optional[Path] = None) -> None:
        import joblib

        d = Path(model_dir or config.MODEL_DIR)
        d.mkdir(parents=True, exist_ok=True)
        joblib.dump(
            {"cost_point": self.cost_point, "cost_safe": self.cost_safe,
             "clf": self.clf, "meta": self.meta.__dict__},
            d / _ARTIFACT,
        )
        (d / "meta.json").write_text(json.dumps(self.meta.__dict__, indent=2, default=str))

    @classmethod
    def load(cls, model_dir: Optional[Path] = None) -> "Estimator":
        import joblib

        d = Path(model_dir or config.MODEL_DIR)
        path = d / _ARTIFACT
        est = cls()
        if path.exists():
            blob = joblib.load(path)
            est.cost_point = blob["cost_point"]
            est.cost_safe = blob["cost_safe"]
            est.clf = blob["clf"]
            est.meta = Meta(**blob["meta"])
        return est
