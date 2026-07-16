"""CLI: retrain the estimator from the SQLite dataset and print accuracy.

    python -m scripts.train        # from the project root, venv active

Prints dataset size, CV MAPE (the number to drive under 20%), and provability
class balance, then writes the model artifacts to EST_MODEL_DIR.
"""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from estimator import data  # noqa: E402
from estimator.model import Estimator  # noqa: E402


def main() -> None:
    rows = data.fetch_all()
    st = data.stats()
    print(f"dataset: {st}")
    if not rows:
        print("no rows yet — ingest some verifier runs first (see seed_from_leak.py)")
        return
    est = Estimator()
    meta = est.train(rows)
    est.save()
    mape = "n/a" if meta.cv_mape is None else f"{meta.cv_mape * 100:.1f}%"
    print(
        f"trained: n_cost={meta.n_cost} prove_rate={meta.prove_rate:.2f} "
        f"CV_MAPE={mape} cost_prior_mode={meta.prior_mode_cost} "
        f"prove_prior_mode={meta.prior_mode_prove} embed={meta.embed}"
    )
    print(f"artifacts → {est.__class__.__name__} saved.")


if __name__ == "__main__":
    main()
