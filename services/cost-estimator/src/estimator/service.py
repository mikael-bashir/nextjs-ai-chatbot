"""FastAPI inference + ingest service — the one process the Leak app talks to.

Endpoints
  GET  /health              liveness + what's loaded
  POST /predict             {signature, budgetUsd?, minProveProb?}
                            → cost estimate + safe cost + prove-prob + reject
  POST /ingest              {signature, proved, actualCostUsd?, wallMs?, model?}
                            record one labelled verifier run (grows the dataset)
  POST /retrain             rebuild models from the dataset, hot-swap in place
  GET  /stats               dataset size + current CV MAPE + model meta

The trained model is held in memory and hot-swapped on /retrain, so /predict
never blocks on disk. Predictions are single-vector and finish in milliseconds
(the local embedding is the only real cost) — inside the 3-second budget.

Run:  uvicorn estimator.service:app --host 0.0.0.0 --port 8900
"""
from __future__ import annotations

import time
from typing import Optional

from fastapi import FastAPI
from pydantic import BaseModel, Field

from . import config, data, reject
from .model import Estimator

app = FastAPI(title="Leak Cost Estimator", version="1.0")

_est: Estimator = Estimator.load()


class PredictIn(BaseModel):
    signature: str = Field(..., description="Raw Lean 4 theorem signature")
    budgetUsd: Optional[float] = None
    minProveProb: Optional[float] = None


class IngestIn(BaseModel):
    signature: str
    proved: bool
    actualCostUsd: Optional[float] = None
    wallMs: Optional[int] = None
    model: Optional[str] = None
    source: str = "verifier"


@app.get("/health")
def health():
    return {
        "ok": True,
        "loaded": not (_est.meta.prior_mode_cost and _est.meta.prior_mode_prove),
        "meta": _est.meta.__dict__,
    }


@app.post("/predict")
def predict(inp: PredictIn):
    t0 = time.perf_counter()
    pred = _est.predict(inp.signature)
    gate = reject.decide(pred, inp.budgetUsd, inp.minProveProb)
    return {
        **pred,
        **gate,
        "prior_mode": pred["prior_mode"],
        "n_train": _est.meta.n_cost,
        "ms": round((time.perf_counter() - t0) * 1000, 1),
    }


@app.post("/ingest")
def ingest(inp: IngestIn):
    rid = data.ingest(
        signature=inp.signature,
        proved=inp.proved,
        actual_cost_usd=inp.actualCostUsd,
        wall_ms=inp.wallMs,
        model=inp.model,
        source=inp.source,
    )
    return {"ok": True, "id": rid, **data.stats()}


@app.post("/retrain")
def retrain():
    global _est
    rows = data.fetch_all()
    est = Estimator()
    meta = est.train(rows)
    est.save()
    _est = est
    return {"ok": True, "meta": meta.__dict__}


@app.get("/stats")
def stats():
    return {"data": data.stats(), "model": _est.meta.__dict__}
