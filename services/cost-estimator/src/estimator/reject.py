"""Production reject gate: decide whether a problem is worth attempting.

Rejects if EITHER the safe (upper-quantile) cost exceeds the caller's budget, OR
the predicted probability of ever proving it is below the floor. Returns the
decision plus human-readable reasons so the API can explain a refusal.
"""
from __future__ import annotations

from typing import Any, Dict, List, Optional

from . import config


def decide(
    prediction: Dict[str, Any],
    budget_usd: Optional[float] = None,
    min_prove_prob: Optional[float] = None,
) -> Dict[str, Any]:
    budget = config.DEFAULT_BUDGET_USD if budget_usd is None else float(budget_usd)
    min_p = config.DEFAULT_MIN_PROVE_PROB if min_prove_prob is None else float(min_prove_prob)

    safe = float(prediction["safe_cost_usd"])
    prob = float(prediction["prove_prob"])
    reasons: List[str] = []
    if safe > budget:
        reasons.append(f"safe cost ${safe:.3f} exceeds budget ${budget:.2f}")
    if prob < min_p:
        reasons.append(f"prove-probability {prob:.2f} below floor {min_p:.2f}")

    return {
        "reject": bool(reasons),
        "reasons": reasons,
        "budget_usd": budget,
        "min_prove_prob": min_p,
    }
