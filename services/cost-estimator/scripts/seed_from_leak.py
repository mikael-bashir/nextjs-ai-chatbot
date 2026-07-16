"""One-off: seed the dataset from Leak's existing proven problems.

Leak's generated store (Redis list `competemath:problems:generated`) holds each
problem's raw Lean theorem (`lean`) alongside its realised cost (`actualUsd`) and
whether it verified — exactly the (signature, cost, proved) triples we need to
bootstrap. This imports them so the pipeline has real data to train/evaluate on
from day one.

    REDIS_URL='rediss://…' python -m scripts.seed_from_leak

Idempotent (dedupes by signature). Requires the `redis` package.
"""
from __future__ import annotations

import json
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from estimator import data  # noqa: E402

STORE_KEY = "competemath:problems:generated"


def main() -> None:
    url = os.environ.get("REDIS_URL")
    if not url:
        print("set REDIS_URL to Leak's Redis (rediss://…) first")
        return
    import redis  # type: ignore

    r = redis.from_url(url, decode_responses=True)
    raws = r.lrange(STORE_KEY, 0, -1)
    seeded = skipped = 0
    for raw in raws:
        try:
            rec = json.loads(raw)
        except Exception:
            continue
        sig = (rec.get("lean") or "").strip()
        cost = rec.get("actualUsd")
        if not sig or cost is None:
            skipped += 1
            continue
        data.ingest(
            signature=sig,
            proved=bool(rec.get("verified", True)),
            actual_cost_usd=float(cost),
            model=rec.get("model"),
            source="seed",
        )
        seeded += 1
    print(f"seeded {seeded} rows, skipped {skipped} (no lean/cost). {data.stats()}")


if __name__ == "__main__":
    main()
