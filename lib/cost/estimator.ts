// Client-side cost estimator glue for the admin pipeline. Extracts a
// deterministic feature vector from a problem, retrieves the nearest past
// proofs (with their actual costs) from the admin cost-history API, asks the
// local bridge's tool-free Opus estimator to predict a dollar cost anchored to
// those neighbors, and persists the estimate so its actual can be recorded
// later. Field names mirror lib/db/cost-history-queries.ts CostFeatures — but
// this file must stay free of the `server-only` DB import.

export interface CostFeatures {
  title?: string | null;
  difficulty?: string | null;
  level?: number | null;
  topic?: string | null;
  problemLen?: number | null;
  leanLen?: number | null;
  usesDecide?: boolean | null;
  isGeneral?: boolean | null;
  hypCount?: number | null;
  decompose?: boolean | null;
  model?: string | null;
}

export interface EstimateResult {
  estimateUsd: number;
  low: number;
  high: number;
  rationale: string;
  model: string;
  /** Row id in proof_cost_history, so the actual cost can be PATCHed later. */
  costHistoryId?: string;
  /** What the estimator call itself cost (overhead), if the bridge reported it. */
  estimatorCostUsd?: number | null;
}

// The problem shape we can pull features from (a superset of the pipeline's
// generated item — every field optional).
export interface ProblemLike {
  questionTitle?: string;
  problem?: string;
  difficulty?: string;
  level?: number;
  topic?: string | null;
  lean?: string;
}

// Deterministic, cheap features. `decompose`/`model` come from the run config.
export function extractFeatures(
  item: ProblemLike,
  opts: { decompose?: boolean; model?: string | null } = {},
): CostFeatures {
  const lean = String(item.lean || '');
  const usesDecide = /\b(?:decide|native_decide)\b/.test(lean);
  // Hypotheses: explicit binder groups `(x : T)` plus arrow-separated premises.
  const binders = (lean.match(/\([^()]*:[^()]*\)/g) || []).length;
  const arrows = (lean.match(/→|->/g) || []).length;
  return {
    title: item.questionTitle || null,
    difficulty: item.difficulty || null,
    level: typeof item.level === 'number' ? item.level : null,
    topic: item.topic ?? null,
    problemLen: item.problem ? item.problem.length : null,
    leanLen: lean.length || null,
    usesDecide,
    // Not a finite `decide` ⇒ a general statement needing real tactics.
    isGeneral: !usesDecide,
    hypCount: binders + arrows,
    decompose: !!opts.decompose,
    model: opts.model ?? null,
  };
}

function neighborQuery(f: CostFeatures): string {
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
 * Full estimate flow: retrieve neighbors → bridge estimate → persist.
 * `callBridge(path, init)` POSTs to the local bridge (admin binds the token).
 * Returns null if the estimator produced no usable number.
 */
export async function estimateCost(opts: {
  features: CostFeatures;
  theorem: string;
  problem: string;
  callBridge: (path: string, init?: RequestInit) => Promise<Response>;
  budgetMs?: number;
}): Promise<EstimateResult | null> {
  const { features, theorem, problem, callBridge, budgetMs } = opts;

  // 1) Retrieve nearest past proofs with actual costs (empirical anchor).
  let neighbors: unknown[] = [];
  try {
    const r = await fetch(`/api/admin/cost-history?${neighborQuery(features)}`);
    if (r.ok) neighbors = (await r.json())?.neighbors ?? [];
  } catch {
    /* cold start / offline history — estimator falls back to goal difficulty */
  }

  // 2) Ask the bridge's Opus estimator (tool-free, few-minute cap).
  const res = await callBridge('/estimate', {
    method: 'POST',
    body: JSON.stringify({
      theorem,
      problem,
      features,
      neighbors,
      model: features.model || undefined,
      budgetMs,
    }),
  });
  if (!res.ok) return null;
  const est = await res.json();
  if (!est?.ok || !Number.isFinite(Number(est.estimateUsd))) return null;

  // 3) Persist the estimate; the returned id lets us record the actual later.
  let costHistoryId: string | undefined;
  try {
    const p = await fetch('/api/admin/cost-history', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        ...features,
        estimateUsd: Number(est.estimateUsd),
        estimateLow: Number(est.low),
        estimateHigh: Number(est.high),
        rationale: est.rationale,
      }),
    });
    if (p.ok) costHistoryId = (await p.json())?.id;
  } catch {
    /* estimate still usable in-session even if persistence fails */
  }

  return {
    estimateUsd: Number(est.estimateUsd),
    low: Number(est.low),
    high: Number(est.high),
    rationale: String(est.rationale || ''),
    model: String(est.model || features.model || 'claude-opus-4-8'),
    costHistoryId,
    estimatorCostUsd:
      est.estimatorCostUsd == null ? null : Number(est.estimatorCostUsd),
  };
}
