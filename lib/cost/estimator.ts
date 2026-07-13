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
  ESTIMATOR_SYSTEM,
  DEFAULT_ESTIMATOR_MODEL,
  DEFAULT_ESTIMATE_BUDGET_MS,
  buildEstimatePrompt,
  parseEstimate,
  extractFeatures,
  type EstimatorFeatures,
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

/**
 * The one seam to swap when changing where/how the estimate runs. Given a fully
 * assembled prompt + system + model + budget, return the model's raw text and
 * (if known) what the call cost.
 */
export type EstimatorTransport = (args: {
  prompt: string;
  system: string;
  model: string;
  budgetMs: number;
}) => Promise<{ text: string; costUsd: number | null }>;

/**
 * Default transport — the local bridge's generic `/run` (your Claude plan).
 * Tool-free + lean flags keep the call cheap. Set ANTHROPIC_API_KEY on the bridge
 * host to bill API credits through this exact path with no code change.
 *
 * The future credit/hosted transport is a sibling of this ~10-line function, e.g.
 *   const apiTransport: EstimatorTransport = async ({prompt, system, model, budgetMs}) => {
 *     const m = await anthropic.messages.create({ model, max_tokens: 4000,
 *       system, messages: [{ role: 'user', content: prompt }] });   // ANTHROPIC_API_KEY
 *     return { text: m.content.find(b => b.type==='text')?.text ?? '', costUsd: null };
 *   };
 */
export function bridgeRunTransport(
  callBridge: (path: string, init?: RequestInit) => Promise<Response>,
): EstimatorTransport {
  return async ({ prompt, system, model, budgetMs }) => {
    const res = await callBridge('/run', {
      method: 'POST',
      body: JSON.stringify({
        prompt,
        options: {
          model,
          systemPrompt: system,
          excludeDynamicSections: true,
          timeoutMs: budgetMs,
          maxOutputTokens: 4000,
        },
      }),
    });
    if (!res.ok) throw new Error(`bridge /run ${res.status}`);
    const j = await res.json();
    return {
      text: String(j?.text || ''),
      costUsd: typeof j?.costUsd === 'number' ? j.costUsd : null,
    };
  };
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
 * Full estimate flow: retrieve neighbors → run through `transport` → parse →
 * persist. `transport` is the only backend-specific dependency. Returns null if
 * the estimator produced no usable number.
 */
export async function estimateCost(opts: {
  features: EstimatorFeatures;
  theorem: string;
  problem: string;
  transport: EstimatorTransport;
  budgetMs?: number;
}): Promise<EstimateResult | null> {
  const { features, theorem, problem, transport } = opts;
  const model = features.model || DEFAULT_ESTIMATOR_MODEL;
  const budgetMs = opts.budgetMs ?? DEFAULT_ESTIMATE_BUDGET_MS;

  // 1) Retrieve nearest past proofs with actual costs (empirical anchor).
  let neighbors: NeighborRow[] = [];
  try {
    const r = await fetch(`/api/admin/cost-history?${neighborQuery(features)}`);
    if (r.ok) neighbors = (await r.json())?.neighbors ?? [];
  } catch {
    /* cold start / offline history — estimator falls back to goal difficulty */
  }

  // 2) Assemble the shared prompt and run it through the transport.
  const prompt = buildEstimatePrompt({ theorem, problem, features, neighbors });
  let text = '';
  let estimatorCostUsd: number | null = null;
  try {
    const out = await transport({
      prompt,
      system: ESTIMATOR_SYSTEM,
      model,
      budgetMs,
    });
    text = out.text;
    estimatorCostUsd = out.costUsd;
  } catch {
    return null;
  }
  const parsed = parseEstimate(text);
  if (!parsed) return null;

  // 3) Persist the estimate; the returned id lets us record the actual later.
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
    estimatorCostUsd,
  };
}
