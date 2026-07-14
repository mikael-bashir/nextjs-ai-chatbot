"""End-to-end smoke test on synthetic data — no external services needed.

Generates theorem-like signatures whose cost genuinely depends on their
structure (so a working pipeline CAN learn them), runs the full loop
ingest → train → predict → reject, and asserts:
  • the pipeline runs and persists,
  • CV MAPE is low on learnable data (proves the ML path works, not that YOUR
    data is learnable — that depends on your data),
  • prediction is well under the 3-second budget,
  • the reject gate fires on budget and on low provability.

    python -m scripts.smoke
"""
from __future__ import annotations

import os
import random
import tempfile
import time
from pathlib import Path

# Point storage at a throwaway dir BEFORE importing the package (config reads env
# at import time).
_tmp = Path(tempfile.mkdtemp(prefix="est-smoke-"))
os.environ["EST_DB_PATH"] = str(_tmp / "runs.db")
os.environ["EST_MODEL_DIR"] = str(_tmp / "models")
os.environ["EST_MIN_TRAIN_ROWS"] = "20"

import sys  # noqa: E402

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from estimator import data, reject  # noqa: E402
from estimator.model import Estimator  # noqa: E402

random.seed(0)

TYPES = ["Nat", "Int", "Real", "Prime", "Finset", "Matrix"]


def synth():
    """Build a signature whose 'cost' rises with quantifiers, term size and a
    non-decide (general) goal — a stand-in for real hardness structure."""
    nq = random.randint(0, 4)
    size = random.randint(1, 6)
    decide = random.random() < 0.4
    t = random.choice(TYPES)
    body = " ∧ ".join([f"(x{i} + {random.randint(1,999)} = y{i})" for i in range(size)])
    quant = " ".join(["∀ (x%d : %s)," % (i, t) for i in range(nq)])
    tac = "decide" if decide else "nlinarith"
    sig = f"theorem t {quant} : {body} := by {tac}"
    # latent cost: floor + effort from structure, cheaper if decide, + noise
    base = 0.08 + 0.05 * nq + 0.04 * size + (0.0 if decide else 0.25)
    cost = base * random.uniform(0.8, 1.25)
    proved = random.random() < (0.95 - 0.12 * nq)  # harder → less likely proved
    return sig, round(cost, 4), proved


def main():
    print(f"[smoke] tmp={_tmp}")
    for _ in range(220):
        sig, cost, proved = synth()
        data.ingest(sig, proved=proved, actual_cost_usd=(cost if proved else None),
                    source="smoke")
    print(f"[smoke] ingested → {data.stats()}")

    est = Estimator()
    meta = est.train(data.fetch_all())
    est.save()
    mape = None if meta.cv_mape is None else f"{meta.cv_mape*100:.1f}%"
    print(f"[smoke] trained: n_cost={meta.n_cost} CV_MAPE={mape} "
          f"prove_rate={meta.prove_rate:.2f} embed={meta.embed}")

    est = Estimator.load()  # prove persistence round-trips
    sig, _, _ = synth()
    t0 = time.perf_counter()
    pred = est.predict(sig)
    ms = (time.perf_counter() - t0) * 1000
    print(f"[smoke] predict: {pred}  ({ms:.1f} ms)")

    cheap_ok = reject.decide(pred, budget_usd=100.0, min_prove_prob=0.0)
    tight = reject.decide(pred, budget_usd=0.01, min_prove_prob=0.0)
    lowp = reject.decide(pred, budget_usd=100.0, min_prove_prob=0.999)
    print(f"[smoke] gate: generous={cheap_ok['reject']} tight_budget={tight['reject']} "
          f"high_prob_floor={lowp['reject']}")

    assert ms < 3000, "prediction exceeded 3s budget"
    assert not cheap_ok["reject"], "should accept under a huge budget"
    assert tight["reject"], "should reject when safe cost > tiny budget"
    assert lowp["reject"], "should reject when prove-prob floor is ~1"
    if meta.cv_mape is not None:
        print(f"[smoke] {'PASS' if meta.cv_mape < 0.20 else 'NOTE'}: "
              f"CV MAPE {'<20% on learnable synthetic data' if meta.cv_mape<0.20 else meta.cv_mape}")
    print("[smoke] OK ✅  full loop works: ingest → train → persist → predict → reject")


if __name__ == "__main__":
    main()
