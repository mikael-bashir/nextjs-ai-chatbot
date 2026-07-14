// Provider-agnostic BRAIN of the cost estimator: the feature vector, the prompt
// + system prompt, and the JSON parser. This file has NO client- or server-only
// imports and no I/O, so every path shares it unchanged:
//   • today  — browser → local bridge `/run` → claude CLI → your Claude plan
//   • later  — server → Anthropic Messages API (ANTHROPIC_API_KEY) → credits
// Switching backends swaps the TRANSPORT (see estimator.ts `EstimatorTransport`),
// never anything in here. Keep the estimator's "how it thinks" in exactly one place.

export const DEFAULT_ESTIMATOR_MODEL = 'claude-opus-4-8';
// The few-minute budget is for the ESTIMATOR call only — never the prover.
export const DEFAULT_ESTIMATE_BUDGET_MS = 180_000;

export interface EstimatorFeatures {
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

export interface NeighborRow {
  difficulty?: string | null;
  level?: number | null;
  lean_len?: number | null;
  uses_decide?: boolean | null;
  is_general?: boolean | null;
  hyp_count?: number | null;
  verified?: boolean | null;
  actual_usd: number;
}

export interface EstimateJson {
  estimateUsd: number;
  low: number;
  high: number;
  rationale: string;
}

// The problem shape features are pulled from (superset of the pipeline item).
export interface ProblemLike {
  questionTitle?: string;
  problem?: string;
  difficulty?: string;
  level?: number;
  topic?: string | null;
  lean?: string;
}

// Deterministic, cheap feature extraction. `decompose`/`model` come from the run
// config. Same field names as the proof_cost_history columns.
export function extractFeatures(
  item: ProblemLike,
  opts: { decompose?: boolean; model?: string | null } = {},
): EstimatorFeatures {
  const lean = String(item.lean || '');
  const usesDecide = /\b(?:decide|native_decide)\b/.test(lean);
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
    isGeneral: !usesDecide, // not a finite `decide` ⇒ needs real tactics
    hypCount: binders + arrows,
    decompose: !!opts.decompose,
    model: opts.model ?? null,
  };
}

// The fixed-overhead floor: EVERY proof pays for the system prompt, the cached
// MCP tool schemas, and a minimum number of agent turns, so no proof — however
// trivial — comes in below roughly this. Empirically the cheap cluster sits at
// ~$0.082–0.10. The estimator is floored to this in code (calibrateEstimate) and
// told about it in the prompt, because a model left to "estimate low" will
// happily predict $0.03 for a problem that physically cannot cost less than the
// floor. Tune if the base model / prompt size / tool set changes materially.
export const COST_FLOOR_USD = 0.08;

export const ESTIMATOR_SYSTEM = `You are a cost estimator for an automated Lean 4 theorem-proving service that proves competition math problems with an agentic Claude prover. Given a problem, its Lean theorem, and a table of SIMILAR PAST proofs with their ACTUAL dollar costs, predict ONE dollar figure: what it will cost to prove THIS problem.

RETURN A SINGLE, SAFE, CONFIDENT NUMBER — not a range. The number is used for budgeting, so it must be one you'd stand behind: it is far worse to UNDER-estimate than to be a little high. When unsure, round toward the safe (higher) side.

THE FLOOR — READ FIRST. Every proof pays a fixed overhead (system prompt, cached tool schemas, a few minimum agent turns), so no proof — however trivial — costs less than about $${COST_FLOOR_USD.toFixed(
    2,
  )}. NEVER predict below the floor, and never below the cheapest neighbor. The classic mistake is estimating $0.02–0.04 for an "easy" goal; that is impossible — such goals land AT the floor, not below it.

ANCHOR ON THE SAFE SIDE. The SIMILAR PAST proofs are ground truth. Anchor near the UPPER end of the closest neighbors' actual costs (about their 75th percentile), NOT the median — this keeps you fair for routine problems while rarely under-shooting. Most routine proofs land near the floor; the agent closes them with automation (decide / native_decide / simp / omega / nlinarith / ring) in one or two attempts. A "general" (non-decide) goal is the NORMAL case — no premium for that alone.

GO HIGH WHEN THE GOAL IS HARD. Do move materially above the neighbor band — into dollars, not cents — when the Lean goal is visibly LARGE, deeply multi-step, or explicitly decomposed (fanning into many sub-proofs). Under-costing a genuinely hard proof is the expensive error; don't suppress it.

Output ONLY this strict JSON object, no prose and no code fences:
{"estimateUsd": <number>, "rationale": "<1-3 sentences: which neighbors you anchored to, and why you went above the band if you did>"}`;

export function buildEstimatePrompt(args: {
  theorem?: string;
  problem?: string;
  features?: EstimatorFeatures;
  neighbors?: NeighborRow[];
}): string {
  const { theorem, problem } = args;
  const f = args.features || {};
  const rows = Array.isArray(args.neighbors) ? args.neighbors : [];
  const table = rows.length
    ? rows
        .map(
          (n) =>
            `- ${n.difficulty || '?'}/L${n.level ?? '?'} decide=${!!n.uses_decide} general=${!!n.is_general} leanLen=${n.lean_len ?? '?'} hyps=${n.hyp_count ?? '?'} → $${Number(n.actual_usd).toFixed(3)} (${n.verified ? 'proved' : 'failed'})`,
        )
        .join('\n')
    : '(no history yet — estimate from the Lean goal alone)';
  return [
    `PROBLEM:\n${String(problem || '(not provided)').slice(0, 4000)}`,
    `\nLEAN THEOREM:\n${String(theorem || '(not provided)').slice(0, 4000)}`,
    `\nFEATURES: difficulty=${f.difficulty ?? '?'}, level=${f.level ?? '?'}, topic=${f.topic ?? '?'}, leanLen=${f.leanLen ?? '?'}, usesDecide=${!!f.usesDecide}, general=${!!f.isGeneral}, hypotheses=${f.hypCount ?? '?'}, decompose=${!!f.decompose}`,
    `\nSIMILAR PAST PROOFS (actual costs — your empirical anchor):\n${table}`,
    `\nPredict the dollar cost to prove THIS problem. Output ONLY the JSON object.`,
  ].join('\n');
}

export function median(xs: number[]): number | null {
  const a = xs.filter((x) => Number.isFinite(x) && x >= 0).sort((p, q) => p - q);
  if (!a.length) return null;
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}

// Deterministic post-hoc calibration — the learning loop the estimator was
// missing. Two corrections, both aimed at the systematic OVER-estimation:
//   1) Bias feedback: biasRel = mean (est-actual)/actual over history. If the
//      estimator has been running high (biasRel > 0), divide it out so the
//      predicted number tracks reality. Needs enough samples; the factor is
//      bounded so a noisy small sample can't wildly swing a prediction. Because
//      we persist the CALIBRATED number, biasRel self-stabilises toward 0.
//   2) Reality rail: never let one estimate exceed a sane multiple of the worst
//      observed neighbour cost (guards the "$40 for a $2 proof" blowups).
export function calibrateEstimate(
  raw: EstimateJson,
  opts: { biasRel?: number | null; n?: number; neighborActuals?: number[] },
): EstimateJson {
  let factor = 1;
  const n = opts.n ?? 0;
  const b = opts.biasRel;
  if (n >= 5 && typeof b === 'number' && Number.isFinite(b) && b > -0.99) {
    // actual ≈ est / (1 + biasRel). Bound to [0.2, 2]: correct at most 5× down
    // (chronic over-estimation) or 2× up, never more on a single call.
    factor = Math.min(2, Math.max(0.2, 1 / (1 + b)));
  }
  let est = raw.estimateUsd * factor;
  const acts = (opts.neighborActuals || [])
    .filter((x) => Number.isFinite(x) && x > 0)
    .sort((p, q) => p - q);
  // Reality rail (top): never let one estimate exceed a sane multiple of the
  // worst observed neighbour — guards the "$40 for a $2 proof" blowups.
  if (acts.length >= 3) {
    const cap = acts[acts.length - 1] * 3;
    if (est > cap && est > 0) est = cap;
  }
  // Hard floor (bottom): no proof costs less than the fixed overhead. Use the
  // larger of the constant floor and the cheapest observed neighbour, so the
  // floor tracks reality if overhead drifts. This is what kills the systematic
  // under-estimation on routine problems (predicting $0.03 for a $0.085 proof).
  const neighborFloor = acts.length ? acts[Math.floor(acts.length * 0.1)] : 0;
  const floor = Math.max(COST_FLOOR_USD, neighborFloor);
  est = Math.max(est, floor);
  const r = (x: number) => Math.max(0, Math.round(x * 1000) / 1000);
  est = r(est);
  // Single confident number: no band. low/high are kept equal to the estimate
  // for backward compatibility with the stored/rendered shape.
  return { estimateUsd: est, low: est, high: est, rationale: raw.rationale };
}

// ────────────────────────────────────────────────────────────────────────────
// DATA-DRIVEN ESTIMATOR (no model). Similarity-weighted conditional-quantile
// regression over proof_cost_history. This REPLACES the LLM: an agent has no
// reliable signal from a Lean goal to a dollar figure, but the empirical costs
// of SIMILAR past proofs do. This is a k-NN / kernel quantile regressor, which is
// UNIVERSALLY CONSISTENT (Stone's theorem): as history grows — neighbours ↑,
// distances ↓ — the prediction provably converges to the true conditional
// τ-quantile Q_τ(cost | features), the optimal predictor. The only residual is
// irreducible proof-search randomness (identical features, different luck), and
// τ controls exactly how safely we sit above it: τ=0.8 ⇒ the estimate lands at or
// above the actual ~80% of the time in the limit. Deterministic, free, instant.

// Safety level of the estimate. 0.8 = a fair-but-safe upper-ish estimate. Raise
// toward 0.9 for a more conservative (rarely-under) number; lower toward 0.5 for
// the central (median) prediction. This is the ONE knob.
export const DEFAULT_QUANTILE = 0.8;

export interface PredictNeighbor {
  actual_usd: number;
  distance: number;
  verified?: boolean | null;
}
export interface GlobalPrior {
  n: number;
  minActual?: number | null;
  q?: number | null; // global τ-quantile of all actuals (cold-start prior)
  median?: number | null;
}

const finite = (x: unknown): number | null => {
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
};
const firstPositive = (...xs: unknown[]): number => {
  for (const x of xs) {
    const n = Number(x);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return COST_FLOOR_USD;
};

// Weighted quantile via the standard cumulative-weight rule: the smallest value
// whose cumulative weight fraction reaches τ.
export function weightedQuantile(
  pts: { v: number; w: number }[],
  tau: number,
): number | null {
  const a = pts.filter((p) => p.w > 0 && Number.isFinite(p.v)).sort((p, q) => p.v - q.v);
  if (!a.length) return null;
  const total = a.reduce((s, p) => s + p.w, 0);
  if (total <= 0) return null;
  let cum = 0;
  for (const p of a) {
    cum += p.w;
    if (cum / total >= tau) return p.v;
  }
  return a[a.length - 1].v;
}

// The estimate: weighted τ-quantile of the closest past proofs' ACTUAL costs,
// shrunk toward the global prior while neighbours are few (so it degrades
// gracefully at cold start), and floored at the fixed overhead. `neighbors` must
// already be the K-nearest with their feature distances (K grows with history).
export function predictCost(
  neighbors: PredictNeighbor[],
  global: GlobalPrior,
  opts: { tau?: number } = {},
): EstimateJson {
  const tau = Math.min(0.99, Math.max(0.5, opts.tau ?? DEFAULT_QUANTILE));
  // Inverse-distance kernel: closer past proofs count more. (distance ≥ 0.)
  const pts = (neighbors || [])
    .map((nb) => ({ v: Number(nb.actual_usd), d: Number(nb.distance) }))
    .filter((p) => Number.isFinite(p.v) && p.v > 0 && Number.isFinite(p.d) && p.d >= 0)
    .map((p) => ({ v: p.v, w: 1 / (1 + p.d) }));

  const localQ = weightedQuantile(pts, tau);
  const prior = firstPositive(global.q, global.median, COST_FLOOR_USD);

  // Cold-start shrinkage: weight the local estimate by how much similar data we
  // have. α → 1 as neighbours accrue, so the prior fades and the estimator
  // becomes purely local — this is the mechanism by which it converges.
  const ess = pts.length;
  const K0 = 8;
  const alpha = ess / (ess + K0);
  let est = localQ == null ? prior : alpha * localQ + (1 - alpha) * prior;

  // Hard floor: nothing costs below the fixed overhead / cheapest observed proof.
  const floor = Math.max(COST_FLOOR_USD, finite(global.minActual) ?? 0);
  est = Math.max(est, floor);

  const r = (x: number) => Math.max(0, Math.round(x * 1000) / 1000);
  est = r(est);
  const pct = Math.round(tau * 100);
  const rationale =
    localQ == null
      ? `No similar history yet — global p${pct} prior $${r(prior)}, floored at $${r(floor)} (n=${global.n}).`
      : `Weighted p${pct} of ${ess} similar past proof(s) = $${r(localQ)}; blended ${Math.round(alpha * 100)}% local / ${Math.round((1 - alpha) * 100)}% prior; floor $${r(floor)}.`;
  // Single confident number (low = high = est): no band.
  return { estimateUsd: est, low: est, high: est, rationale };
}

// Pull the estimator's JSON out of its reply (tolerating stray prose/fences).
export function parseEstimate(text: string): EstimateJson | null {
  const t = String(text || '');
  const m = t.match(/\{[\s\S]*\}/);
  if (!m) return null;
  let o: Record<string, unknown>;
  try {
    o = JSON.parse(m[0]);
  } catch {
    return null;
  }
  const est = Number(o.estimateUsd);
  if (!Number.isFinite(est) || est < 0) return null;
  const low = Number.isFinite(Number(o.low)) ? Number(o.low) : est;
  const high = Number.isFinite(Number(o.high)) ? Number(o.high) : est;
  return {
    estimateUsd: est,
    low: Math.min(low, est),
    high: Math.max(high, est),
    rationale: typeof o.rationale === 'string' ? o.rationale.slice(0, 600) : '',
  };
}
