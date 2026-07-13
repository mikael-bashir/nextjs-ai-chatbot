import 'server-only';

import { sql } from '@vercel/postgres';

if (!process.env.POSTGRES_URL) {
  throw new Error('POSTGRES_URL environment variable is not set.');
}

// The cost estimator's memory: one row per problem piped to the verifier queue,
// carrying the feature vector, the estimate we made BEFORE proving, and the
// actual cost recorded AFTER. Retrieval over the rows-with-actuals is what lets
// the estimator learn from experience. Snake_case, raw SQL — this table is only
// read/written by the admin cost-history route, never by drizzle schema code.
let tableEnsured = false;
async function ensureTable(): Promise<void> {
  if (tableEnsured) return;
  await sql`
    CREATE TABLE IF NOT EXISTS proof_cost_history (
      id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      title         text,
      difficulty    varchar(32),
      level         integer,
      topic         varchar(64),
      problem_len   integer,
      lean_len      integer,
      uses_decide   boolean,
      is_general    boolean,
      hyp_count     integer,
      decompose     boolean,
      model         varchar(64),
      estimate_usd  double precision,
      estimate_low  double precision,
      estimate_high double precision,
      rationale     text,
      actual_usd    double precision,
      verified      boolean,
      created_at    timestamptz NOT NULL DEFAULT now()
    );
  `;
  tableEnsured = true;
}

// The deterministic feature vector extracted from a problem. Kept in sync with
// lib/cost/estimator.ts extractFeatures() (client-side) — same field names.
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

export interface EstimateInput extends CostFeatures {
  estimateUsd: number;
  estimateLow?: number | null;
  estimateHigh?: number | null;
  rationale?: string | null;
}

// Difficulty → ordinal, used both to store nothing extra and to compute the
// neighbour distance in SQL. Easy 1 … Insane 4; unknown maps to Medium.
const DIFF_ORD: Record<string, number> = {
  Easy: 1,
  Medium: 2,
  Hard: 3,
  Insane: 4,
};
function diffOrd(d?: string | null): number {
  return DIFF_ORD[String(d ?? '')] ?? 2;
}

// Insert the estimate we made before proving; returns the new row id so the UI
// can PATCH the actual cost onto it once the proof completes.
export async function insertEstimate(input: EstimateInput): Promise<string> {
  await ensureTable();
  const { rows } = await sql`
    INSERT INTO proof_cost_history
      (title, difficulty, level, topic, problem_len, lean_len, uses_decide,
       is_general, hyp_count, decompose, model,
       estimate_usd, estimate_low, estimate_high, rationale)
    VALUES
      (${input.title ?? null}, ${input.difficulty ?? null}, ${input.level ?? null},
       ${input.topic ?? null}, ${input.problemLen ?? null}, ${input.leanLen ?? null},
       ${input.usesDecide ?? null}, ${input.isGeneral ?? null}, ${input.hypCount ?? null},
       ${input.decompose ?? null}, ${input.model ?? null},
       ${input.estimateUsd}, ${input.estimateLow ?? null}, ${input.estimateHigh ?? null},
       ${input.rationale ?? null})
    RETURNING id;
  `;
  return rows[0].id as string;
}

// Stamp the actual cost onto a row once the proof run finishes.
export async function recordActual(
  id: string,
  actualUsd: number,
  verified: boolean,
): Promise<void> {
  await ensureTable();
  await sql`
    UPDATE proof_cost_history
    SET actual_usd = ${actualUsd}, verified = ${verified}
    WHERE id = ${id};
  `;
}

export interface Neighbor {
  title: string | null;
  difficulty: string | null;
  level: number | null;
  lean_len: number | null;
  uses_decide: boolean | null;
  is_general: boolean | null;
  hyp_count: number | null;
  verified: boolean | null;
  actual_usd: number;
  distance: number;
}

// The K most similar PAST problems that already have an actual cost — the
// empirical anchor handed to the estimator. Weighted feature distance with
// difficulty and general-vs-finite dominating (they matter most for proof cost).
export async function nearestNeighbors(
  features: CostFeatures,
  k = 8,
): Promise<Neighbor[]> {
  await ensureTable();
  const ord = diffOrd(features.difficulty);
  const level = features.level ?? 3;
  const leanLen = features.leanLen ?? 0;
  const usesDecide = features.usesDecide ?? false;
  const isGeneral = features.isGeneral ?? false;
  const hypCount = features.hypCount ?? 0;
  const topic = features.topic ?? '';
  const { rows } = await sql`
    SELECT title, difficulty, level, lean_len, uses_decide, is_general,
           hyp_count, verified, actual_usd,
           ( 3.0 * abs(
               (CASE difficulty WHEN 'Easy' THEN 1 WHEN 'Medium' THEN 2
                                WHEN 'Hard' THEN 3 WHEN 'Insane' THEN 4 ELSE 2 END) - ${ord})
           + 1.0 * abs(coalesce(level, 3) - ${level})
           + 1.0 * abs(coalesce(lean_len, 0) - ${leanLen}) / 200.0
           + 1.5 * (CASE WHEN coalesce(uses_decide, false) = ${usesDecide} THEN 0 ELSE 1 END)
           + 2.0 * (CASE WHEN coalesce(is_general, false) = ${isGeneral} THEN 0 ELSE 1 END)
           + 0.5 * abs(coalesce(hyp_count, 0) - ${hypCount}) / 3.0
           + 0.5 * (CASE WHEN coalesce(topic, '') = ${topic} THEN 0 ELSE 1 END)
           ) AS distance
    FROM proof_cost_history
    WHERE actual_usd IS NOT NULL
    ORDER BY distance ASC, created_at DESC
    LIMIT ${k};
  `;
  return rows as unknown as Neighbor[];
}

export interface AccuracyStats {
  n: number;
  mape: number | null; // mean absolute percentage error
  biasRel: number | null; // mean signed relative error (est-actual)/actual
  biasAbs: number | null; // mean signed dollar error
  byDifficulty: {
    difficulty: string;
    n: number;
    mape: number | null;
  }[];
}

// The estimator scoreboard: how close estimates have been to actuals overall and
// per difficulty. Only rows with both an estimate and a recorded actual count.
export async function accuracyStats(): Promise<AccuracyStats> {
  await ensureTable();
  const overall = await sql`
    SELECT count(*)::int AS n,
           avg( abs(actual_usd - estimate_usd) / nullif(actual_usd, 0) ) AS mape,
           avg( (estimate_usd - actual_usd) / nullif(actual_usd, 0) ) AS bias_rel,
           avg( estimate_usd - actual_usd ) AS bias_abs
    FROM proof_cost_history
    WHERE actual_usd IS NOT NULL AND estimate_usd IS NOT NULL;
  `;
  const byDiff = await sql`
    SELECT coalesce(difficulty, '—') AS difficulty, count(*)::int AS n,
           avg( abs(actual_usd - estimate_usd) / nullif(actual_usd, 0) ) AS mape
    FROM proof_cost_history
    WHERE actual_usd IS NOT NULL AND estimate_usd IS NOT NULL
    GROUP BY 1
    ORDER BY 1;
  `;
  const o = overall.rows[0] || {};
  const num = (v: unknown): number | null =>
    v == null ? null : Number(v);
  return {
    n: Number(o.n ?? 0),
    mape: num(o.mape),
    biasRel: num(o.bias_rel),
    biasAbs: num(o.bias_abs),
    byDifficulty: byDiff.rows.map((r) => ({
      difficulty: String(r.difficulty),
      n: Number(r.n),
      mape: num(r.mape),
    })),
  };
}
