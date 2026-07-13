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

export const ESTIMATOR_SYSTEM = `You are a cost estimator for an automated Lean 4 theorem-proving service that proves competition math problems with an agentic Claude prover. Given a problem, its Lean theorem, and a table of SIMILAR PAST proofs with their ACTUAL dollar costs, predict what it will cost to prove THIS problem.

Reason about proof-search difficulty from the Lean goal itself: a decide/native_decide over a small finite domain is cheap; a general closed-form statement needing induction, algebra, or lemma search is far more expensive; deep multi-step or decomposable goals cost the most (they fan out into many sub-proofs). Longer/among-more-hypotheses goals trend costlier.

The SIMILAR PAST proofs are ground truth — ANCHOR your number to them, then adjust up or down for how this goal differs. If there is little/no history, estimate from the goal's intrinsic difficulty (typical proofs run about $0.05–$5, hard/decomposed ones can exceed $10).

Output ONLY this strict JSON object, no prose and no code fences:
{"estimateUsd": <number>, "low": <number>, "high": <number>, "rationale": "<1-3 sentences: the key drivers and which neighbors you anchored to>"}`;

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
