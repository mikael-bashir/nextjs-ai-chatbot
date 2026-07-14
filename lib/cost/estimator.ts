// Estimator ORCHESTRATION: retrieve neighbors → run the shared prompt through a
// pluggable LLM transport → parse → persist. The "brain" (features, prompt,
// parser) lives in estimate-core.ts; this file only wires I/O and the transport.
//
// THE SWITCH SEAM is `EstimatorTransport`. Today the only implementation is
// `bridgeRunTransport` (browser → local bridge `/run` → claude CLI → your plan).
// To move to API credits / a hosted service you implement ONE transport that
// calls the Anthropic Messages API and pass it to `estimateCost` — nothing else
// here changes. (And even the current transport bills credits instead of the
// plan the moment ANTHROPIC_API_KEY is set on the bridge host — no code change.)

import {
  DEFAULT_ESTIMATOR_MODEL,
  DEFAULT_QUANTILE,
  predictCost,
  extractFeatures,
  type EstimatorFeatures,
  type GlobalPrior,
  type NeighborRow,
} from './estimate-core';

export { extractFeatures };
export type { EstimatorFeatures, NeighborRow };
// Back-compat alias (older name used around the codebase / DB layer).
export type CostFeatures = EstimatorFeatures;

export interface EstimateResult {
  estimateUsd: number;
  low: number;
  high: number;
  rationale: string;
  model: string;
  /** Row id in proof_cost_history, so the actual cost can be PATCHed later. */
  costHistoryId?: string;
  /** What the estimator call itself cost (overhead), if the transport knows it. */
  estimatorCostUsd?: number | null;
}

function neighborQuery(f: EstimatorFeatures): string {
  const p = new URLSearchParams();
  p.set('neighbors', '1');
  const put = (k: string, v: unknown) => {
    if (v != null && v !== '') p.set(k, String(v));
  };
  put('difficulty', f.difficulty);
  put('level', f.level);
  put('topic', f.topic);
  put('leanLen', f.leanLen);
  put('usesDecide', f.usesDecide);
  put('isGeneral', f.isGeneral);
  put('hypCount', f.hypCount);
  return p.toString();
}

/**
 * Full estimate flow: retrieve the K nearest past proofs (with actual costs) +
 * the global prior → run the deterministic k-NN quantile regressor → persist.
 * No model, no API/plan cost, instant. Returns null only if persistence and
 * retrieval both fail (nothing to predict from AND cannot record).
 *
 * `transport`/`budgetMs` are accepted but ignored — kept so existing callers
 * compile unchanged while the LLM path is retired.
 */
export async function estimateCost(opts: {
  features: EstimatorFeatures;
  theorem?: string;
  problem?: string;
  tau?: number;
  transport?: unknown;
  budgetMs?: number;
}): Promise<EstimateResult | null> {
  const { features } = opts;
  const model = features.model || DEFAULT_ESTIMATOR_MODEL;

  // 1) Retrieve the K nearest past proofs (with their ACTUAL costs + feature
  // distances) and the global cost prior. K grows with history server-side.
  let neighbors: NeighborRow[] = [];
  let global: GlobalPrior = { n: 0 };
  try {
    const r = await fetch(`/api/admin/cost-history?${neighborQuery(features)}`);
    if (r.ok) {
      const j = await r.json();
      neighbors = Array.isArray(j?.neighbors) ? j.neighbors : [];
      if (j?.global) global = j.global as GlobalPrior;
    }
  } catch {
    /* cold start / offline — predictCost falls back to the floor prior */
  }

  // 2) Predict: similarity-weighted τ-quantile of neighbour actuals, shrunk to
  // the prior while data is thin, floored at the fixed overhead. Deterministic.
  const parsed = predictCost(
    neighbors.map((nb) => ({
      actual_usd: Number((nb as { actual_usd?: number }).actual_usd),
      distance: Number((nb as { distance?: number }).distance),
    })),
    global,
    { tau: opts.tau ?? DEFAULT_QUANTILE },
  );

  // 3) Persist the estimate; the returned id lets us record the actual later so
  // this very prediction becomes a training point for future estimates.
  let costHistoryId: string | undefined;
  try {
    const p = await fetch('/api/admin/cost-history', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        ...features,
        estimateUsd: parsed.estimateUsd,
        estimateLow: parsed.low,
        estimateHigh: parsed.high,
        rationale: parsed.rationale,
      }),
    });
    if (p.ok) costHistoryId = (await p.json())?.id;
  } catch {
    /* estimate still usable in-session even if persistence fails */
  }

  return {
    ...parsed,
    model,
    costHistoryId,
    estimatorCostUsd: 0, // the estimator itself is free now
  };
}
