# leak-cost-estimator

A self-hosted service that, given **only a Lean 4 theorem signature**, predicts
what it will cost the Leak verifier to prove it — and flat-out **rejects**
problems that are too expensive or likely unprovable. It **trains on its own data**:
every proof the verifier runs is logged as a labelled example, and the model
sharpens as you generate problems. No difficulty labels, no human input at
inference — just the signature.

Targets: **MAPE < 20%** on cost, a reliable reject gate, **< 3 s** inference.

## Why a separate project
Cost estimation is a real ML problem (feature engineering, embeddings, quantile
regression, calibration, a data-collection loop). It doesn't belong wedged inside
the Next.js app. This is a small Python service the Leak app calls over HTTP —
the same pattern as the existing `python-backend`.

## How it works
```
Lean signature ──► [ structural features  ‖  local semantic embedding ] ──► models
                     (quantifiers, ops,        (self-hosted sentence-         │
                      term size, decide-        transformer; hashing          │
                      ability, …)               fallback if not installed)    │
                                                                              ▼
                                        cost: two GBT quantile regressors (point + safe)
                                        provable: GBT classifier → P(proved)
                                                                              │
                                                                              ▼
                                        reject if  safe_cost > budget  OR  P(proved) < floor
```
- **Self-improving**: `POST /ingest` records every `(signature, cost, proved)` the
  verifier produces. `POST /retrain` rebuilds the models from the growing dataset.
- **Graceful cold start**: under `EST_MIN_TRAIN_ROWS` labelled rows it returns a
  robust global prior instead of a bad fit — useful from row 1.
- **Fast**: inference is one feature-vector build + a couple of tree evals; the
  local embedding is the only real latency (ms). Well inside 3 s.

## API
| Method | Path | Body / result |
|---|---|---|
| `GET`  | `/health`  | liveness + loaded-model meta |
| `POST` | `/predict` | `{signature, budgetUsd?, minProveProb?}` → `{est_cost_usd, safe_cost_usd, prove_prob, reject, reasons, ms}` |
| `POST` | `/ingest`  | `{signature, proved, actualCostUsd?, wallMs?, model?}` → grows the dataset |
| `POST` | `/retrain` | rebuild + hot-swap models, returns CV MAPE |
| `GET`  | `/stats`   | dataset size, class balance, current MAPE |

## Run it
```bash
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt

# (optional) bootstrap from Leak's existing proven problems
REDIS_URL='rediss://…' python -m scripts.seed_from_leak

python -m scripts.train                                   # train + print MAPE
uvicorn estimator.service:app --host 0.0.0.0 --port 8900  # serve
```
Upgrade the embeddings from the hashing fallback to a real local model any time:
uncomment `sentence-transformers` in `requirements.txt`, `pip install`, `/retrain`.
No code change.

## Wiring into Leak
**1. Log every proof (grows the training set).** In the bridge/verifier, when a
run finishes, fire-and-forget:
```ts
fetch(`${ESTIMATOR_URL}/ingest`, {
  method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({
    signature: theorem,           // the raw Lean goal
    proved: outcome.verified,
    actualCostUsd: outcome.costUsd ?? null,
    wallMs: elapsedMs,
    model,
  }),
}).catch(() => {});               // best-effort, never block the prove
```
**2. Estimate / gate before proving.**
```ts
const r = await fetch(`${ESTIMATOR_URL}/predict`, {
  method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ signature: theorem, budgetUsd: 5 }),
}).then(r => r.json());
if (r.reject) refuse(r.reasons);
else quote(r.est_cost_usd, r.safe_cost_usd);
```

## Deploy (alongside the app)
Add to Leak's `docker-compose.prod.yml`:
```yaml
  cost-estimator:
    build: ../leak-cost-estimator      # or a prebuilt image
    ports: ["8900:8900"]
    volumes: [ "estimator-data:/data", "estimator-models:/models" ]
    restart: always
```
Point the app at it with `ESTIMATOR_URL=http://cost-estimator:8900`.

## Roadmap (as data grows)
- Swap hashing → local sentence-transformer embeddings (one line).
- **Conformal calibration** on top of the safe quantile → a distribution-free
  coverage guarantee ("estimate ≥ actual X% of the time").
- Active learning: surface the highest-uncertainty problems for labelling first.
- Per-model cost heads (Opus/Sonnet/Haiku) once the mix varies.
