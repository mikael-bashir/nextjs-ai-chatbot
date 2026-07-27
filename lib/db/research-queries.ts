import 'server-only';

import { sql } from '@vercel/postgres';

if (!process.env.POSTGRES_URL) {
  throw new Error('POSTGRES_URL environment variable is not set.');
}

// Research telemetry for the two prover systems under comparison this round:
//   Leak River      — the Goedel-Architect-style blueprint pipeline (Grok driver),
//                     in three variants distinguished by the `strategy` column:
//                       river-stone  CONTROL: the paper as written.
//                       river-gate   + shared dead-end ledger across node provers.
//                       river-delta  + one-shot local Sonnet 5 NL-proof seed.
//                     All three share one table so a single GROUP BY strategy
//                     compares them; the extra columns are null for variants that
//                     don't produce them (e.g. cost_seed_usd only on delta).
//   Leak Ultra      — Stone's blueprint pipeline driven by the LOCAL Claude CLI
//                     instead of the xAI API (strategy `ultra-fleeting`). Same
//                     columns as River minus the Grok-only token buckets: the CLI
//                     reports one authoritative total_cost_usd, not per-bucket
//                     counts. Its own table because the DRIVER differs, so its
//                     rows are not a River ablation and must not be averaged in.
//   Leak Stronghold — the existing Claude-driven strategies (hacker/pantograph/
//                     librarian/sketch/brute/have/have-tree, single-agent or
//                     decomposed). `have-tree` is displayed as "Leak Stronghold
//                     Dark"; the stored value stays `have-tree`.
//
// Every table records the Lean toolchain + Mathlib version that ACTUALLY
// certified the run (lean_toolchain / mathlib_version): the two verifier groups
// are NOT on the same Lean (Leak XI/XII/XIV = 4.32.0, Leak I/II/IV = 4.29.1), so
// a row without it can't be reproduced and a certificate built from it would be
// making an unverified claim.
// One row per verification ATTEMPT (not per problem — re-verifying the same
// theorem logs a new row), auto-recorded by the admin pipeline whenever a run
// finishes. Raw SQL / ensureTable, same pattern as proof_cost_history — this is
// scratch research data, not part of the customer-facing schema.
let tablesEnsured = false;
async function ensureTables(): Promise<void> {
  if (tablesEnsured) return;
  await sql`
    CREATE TABLE IF NOT EXISTS leak_river_runs (
      id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      created_at           timestamptz NOT NULL DEFAULT now(),
      generated_item_id    text,
      problem_title        text,
      difficulty           varchar(32),
      theorem_name         text,
      sorried_theorem      text,
      strategy             varchar(32),
      model                varchar(64),
      models_used          text[],
      nl_seed_used         boolean,
      verified             boolean,
      refuted              boolean,
      cost_usd             double precision,
      cost_driver_usd      double precision,
      cost_seed_usd        double precision,
      prompt_tokens        integer,
      completion_tokens    integer,
      cached_tokens        integer,
      cost_cap_hit         boolean,
      compute_budget_ms    integer,
      time_elapsed_s       integer,
      llm_calls            integer,
      tool_calls           integer,
      max_iters            integer,
      blueprint_iterations integer,
      nodes_total          integer,
      nodes_solved         integer,
      nodes_forfeited      integer,
      nodes_negated        integer,
      dead_ends_shared     integer,
      dead_ends_known      integer,
      lean_toolchain       text,
      mathlib_version      text,
      final_proof          text,
      error                text,
      bridge_build         text,
      notes                text
    );
  `;
  // Leak Ultra — same pipeline as river-stone, Claude CLI driver. No prompt/
  // completion/cached buckets: the CLI reports a combined token total and an
  // authoritative dollar cost, so `cost_usd` here needs no price assumptions.
  await sql`
    CREATE TABLE IF NOT EXISTS leak_ultra_runs (
      id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      created_at           timestamptz NOT NULL DEFAULT now(),
      generated_item_id    text,
      problem_title        text,
      difficulty           varchar(32),
      theorem_name         text,
      sorried_theorem      text,
      strategy             varchar(32),
      model                varchar(64),
      models_used          text[],
      verified             boolean,
      refuted              boolean,
      cost_usd             double precision,
      tokens               integer,
      cost_cap_hit         boolean,
      compute_budget_ms    integer,
      time_elapsed_s       integer,
      llm_calls            integer,
      tool_calls           integer,
      max_iters            integer,
      blueprint_iterations integer,
      nodes_total          integer,
      nodes_solved         integer,
      nodes_forfeited      integer,
      nodes_negated        integer,
      lean_toolchain       text,
      mathlib_version      text,
      final_proof          text,
      error                text,
      bridge_build         text,
      notes                text
    );
  `;
  await sql`
    CREATE TABLE IF NOT EXISTS leak_stronghold_runs (
      id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      created_at        timestamptz NOT NULL DEFAULT now(),
      generated_item_id text,
      problem_title     text,
      difficulty        varchar(32),
      theorem_name      text,
      sorried_theorem   text,
      model             varchar(64),
      models_used       text[],
      strategy          varchar(32),
      verified          boolean,
      refuted           boolean,
      cost_usd          double precision,
      compute_budget_ms integer,
      time_elapsed_s    integer,
      llm_calls         integer,
      tool_calls        integer,
      have_case_count   integer,
      checkpoint_used   boolean,
      lean_toolchain    text,
      mathlib_version   text,
      final_proof       text,
      error             text,
      bridge_build      text,
      notes             text
    );
  `;
  // Idempotent migration for tables created by an earlier version of this file
  // (CREATE TABLE IF NOT EXISTS won't alter an existing table). `points` is
  // dropped: it's a CompeteMath scoring artefact with no research meaning.
  const riverAdds = [
    'strategy varchar(32)',
    'models_used text[]',
    'cost_driver_usd double precision',
    'cost_seed_usd double precision',
    'prompt_tokens integer',
    'completion_tokens integer',
    'cached_tokens integer',
    'max_iters integer',
    'dead_ends_shared integer',
    'dead_ends_known integer',
    'lean_toolchain text',
    'mathlib_version text',
  ];
  for (const col of riverAdds) {
    await sql.query(
      `ALTER TABLE leak_river_runs ADD COLUMN IF NOT EXISTS ${col}`,
    );
  }
  for (const col of [
    'models_used text[]',
    'lean_toolchain text',
    'mathlib_version text',
  ]) {
    await sql.query(
      `ALTER TABLE leak_stronghold_runs ADD COLUMN IF NOT EXISTS ${col}`,
    );
  }
  await sql.query('ALTER TABLE leak_river_runs DROP COLUMN IF EXISTS points');
  await sql.query(
    'ALTER TABLE leak_stronghold_runs DROP COLUMN IF EXISTS points',
  );
  tablesEnsured = true;
}

export interface RiverRunInput {
  generatedItemId?: string | null;
  problemTitle?: string | null;
  difficulty?: string | null;
  theoremName?: string | null;
  sorriedTheorem: string;
  /** Which Leak River variant ran: river-stone | river-gate | river-delta. */
  strategy?: string | null;
  /** The driver model (Grok) the run was configured with. */
  model?: string | null;
  /** Every model that actually served a call, incl. ladder fallbacks + the seed. */
  modelsUsed?: string[] | null;
  nlSeedUsed?: boolean | null;
  verified: boolean;
  refuted?: boolean | null;
  /** Total = driver + seed. The per-source split and raw token counts are kept
   *  alongside so cost can be recomputed if published prices change. */
  costUsd?: number | null;
  costDriverUsd?: number | null;
  costSeedUsd?: number | null;
  promptTokens?: number | null;
  completionTokens?: number | null;
  cachedTokens?: number | null;
  costCapHit?: boolean | null;
  computeBudgetMs?: number | null;
  timeElapsedS?: number | null;
  llmCalls?: number | null;
  toolCalls?: number | null;
  /** Refinement budget allotted vs iterations actually reached. */
  maxIters?: number | null;
  blueprintIterations?: number | null;
  nodesTotal?: number | null;
  nodesSolved?: number | null;
  nodesForfeited?: number | null;
  nodesNegated?: number | null;
  /** Dead-end ledger (gate/delta): facts injected into prompts, and distinct
   *  facts learned. Null on the control, which runs without a ledger. */
  deadEndsShared?: number | null;
  deadEndsKnown?: number | null;
  /** Lean toolchain + Mathlib version that certified this run (from the armed
   *  verifier group, NOT assumed) — needed to reproduce the row. */
  leanToolchain?: string | null;
  mathlibVersion?: string | null;
  finalProof?: string | null;
  error?: string | null;
  bridgeBuild?: string | null;
  notes?: string | null;
}

export async function insertRiverRun(input: RiverRunInput): Promise<string> {
  await ensureTables();
  const { rows } = await sql`
    INSERT INTO leak_river_runs
      (generated_item_id, problem_title, difficulty, theorem_name,
       sorried_theorem, strategy, model, models_used, nl_seed_used, verified,
       refuted, cost_usd, cost_driver_usd, cost_seed_usd, prompt_tokens,
       completion_tokens, cached_tokens, cost_cap_hit, compute_budget_ms,
       time_elapsed_s, llm_calls, tool_calls, max_iters, blueprint_iterations,
       nodes_total, nodes_solved, nodes_forfeited, nodes_negated,
       dead_ends_shared, dead_ends_known, lean_toolchain, mathlib_version,
       final_proof, error, bridge_build, notes)
    VALUES
      (${input.generatedItemId ?? null}, ${input.problemTitle ?? null},
       ${input.difficulty ?? null}, ${input.theoremName ?? null},
       ${input.sorriedTheorem}, ${input.strategy ?? null}, ${input.model ?? null},
       ${(input.modelsUsed ?? null) as unknown as string}, ${input.nlSeedUsed ?? null},
       ${input.verified}, ${input.refuted ?? null}, ${input.costUsd ?? null},
       ${input.costDriverUsd ?? null}, ${input.costSeedUsd ?? null},
       ${input.promptTokens ?? null}, ${input.completionTokens ?? null},
       ${input.cachedTokens ?? null}, ${input.costCapHit ?? null},
       ${input.computeBudgetMs ?? null}, ${input.timeElapsedS ?? null},
       ${input.llmCalls ?? null}, ${input.toolCalls ?? null}, ${input.maxIters ?? null},
       ${input.blueprintIterations ?? null}, ${input.nodesTotal ?? null},
       ${input.nodesSolved ?? null}, ${input.nodesForfeited ?? null},
       ${input.nodesNegated ?? null}, ${input.deadEndsShared ?? null},
       ${input.deadEndsKnown ?? null}, ${input.leanToolchain ?? null},
       ${input.mathlibVersion ?? null}, ${input.finalProof ?? null}, ${input.error ?? null},
       ${input.bridgeBuild ?? null}, ${input.notes ?? null})
    RETURNING id;
  `;
  return rows[0].id as string;
}

export async function listRiverRuns(limit = 500): Promise<Record<string, unknown>[]> {
  await ensureTables();
  const { rows } = await sql`
    SELECT * FROM leak_river_runs ORDER BY created_at DESC LIMIT ${limit};
  `;
  return rows;
}

// ── Leak Ultra ───────────────────────────────────────────────────────────────
export interface UltraRunInput {
  generatedItemId?: string | null;
  problemTitle?: string | null;
  difficulty?: string | null;
  theoremName?: string | null;
  sorriedTheorem: string;
  /** Always 'ultra-fleeting' today; kept as a column for future Ultra variants. */
  strategy?: string | null;
  /** The Claude model the operator picked in the dropdown (inherited verbatim). */
  model?: string | null;
  modelsUsed?: string[] | null;
  verified: boolean;
  refuted?: boolean | null;
  /** The CLI's own authoritative total_cost_usd, summed across every stage —
   *  no price table, so it cannot drift when published prices change. */
  costUsd?: number | null;
  tokens?: number | null;
  costCapHit?: boolean | null;
  computeBudgetMs?: number | null;
  timeElapsedS?: number | null;
  llmCalls?: number | null;
  toolCalls?: number | null;
  maxIters?: number | null;
  blueprintIterations?: number | null;
  nodesTotal?: number | null;
  nodesSolved?: number | null;
  nodesForfeited?: number | null;
  nodesNegated?: number | null;
  leanToolchain?: string | null;
  mathlibVersion?: string | null;
  finalProof?: string | null;
  error?: string | null;
  bridgeBuild?: string | null;
  notes?: string | null;
}

export async function insertUltraRun(input: UltraRunInput): Promise<string> {
  await ensureTables();
  const { rows } = await sql`
    INSERT INTO leak_ultra_runs
      (generated_item_id, problem_title, difficulty, theorem_name,
       sorried_theorem, strategy, model, models_used, verified, refuted,
       cost_usd, tokens, cost_cap_hit, compute_budget_ms, time_elapsed_s,
       llm_calls, tool_calls, max_iters, blueprint_iterations, nodes_total,
       nodes_solved, nodes_forfeited, nodes_negated, lean_toolchain,
       mathlib_version, final_proof, error, bridge_build, notes)
    VALUES
      (${input.generatedItemId ?? null}, ${input.problemTitle ?? null},
       ${input.difficulty ?? null}, ${input.theoremName ?? null},
       ${input.sorriedTheorem}, ${input.strategy ?? null}, ${input.model ?? null},
       ${(input.modelsUsed ?? null) as unknown as string}, ${input.verified},
       ${input.refuted ?? null}, ${input.costUsd ?? null}, ${input.tokens ?? null},
       ${input.costCapHit ?? null}, ${input.computeBudgetMs ?? null},
       ${input.timeElapsedS ?? null}, ${input.llmCalls ?? null},
       ${input.toolCalls ?? null}, ${input.maxIters ?? null},
       ${input.blueprintIterations ?? null}, ${input.nodesTotal ?? null},
       ${input.nodesSolved ?? null}, ${input.nodesForfeited ?? null},
       ${input.nodesNegated ?? null}, ${input.leanToolchain ?? null},
       ${input.mathlibVersion ?? null}, ${input.finalProof ?? null},
       ${input.error ?? null}, ${input.bridgeBuild ?? null}, ${input.notes ?? null})
    RETURNING id;
  `;
  return rows[0].id as string;
}

export async function listUltraRuns(
  limit = 500,
): Promise<Record<string, unknown>[]> {
  await ensureTables();
  const { rows } = await sql`
    SELECT * FROM leak_ultra_runs ORDER BY created_at DESC LIMIT ${limit};
  `;
  return rows;
}

export interface StrongholdRunInput {
  generatedItemId?: string | null;
  problemTitle?: string | null;
  difficulty?: string | null;
  theoremName?: string | null;
  sorriedTheorem: string;
  model?: string | null;
  /** Every model that actually served a call during the run. */
  modelsUsed?: string[] | null;
  strategy?: string | null;
  verified: boolean;
  refuted?: boolean | null;
  costUsd?: number | null;
  computeBudgetMs?: number | null;
  timeElapsedS?: number | null;
  llmCalls?: number | null;
  toolCalls?: number | null;
  haveCaseCount?: number | null;
  checkpointUsed?: boolean | null;
  leanToolchain?: string | null;
  mathlibVersion?: string | null;
  finalProof?: string | null;
  error?: string | null;
  bridgeBuild?: string | null;
  notes?: string | null;
}

export async function insertStrongholdRun(
  input: StrongholdRunInput,
): Promise<string> {
  await ensureTables();
  const { rows } = await sql`
    INSERT INTO leak_stronghold_runs
      (generated_item_id, problem_title, difficulty, theorem_name,
       sorried_theorem, model, models_used, strategy, verified, refuted, cost_usd,
       compute_budget_ms, time_elapsed_s, llm_calls, tool_calls,
       have_case_count, checkpoint_used, lean_toolchain, mathlib_version,
       final_proof, error, bridge_build, notes)
    VALUES
      (${input.generatedItemId ?? null}, ${input.problemTitle ?? null},
       ${input.difficulty ?? null}, ${input.theoremName ?? null},
       ${input.sorriedTheorem}, ${input.model ?? null},
       ${(input.modelsUsed ?? null) as unknown as string}, ${input.strategy ?? null},
       ${input.verified}, ${input.refuted ?? null}, ${input.costUsd ?? null},
       ${input.computeBudgetMs ?? null}, ${input.timeElapsedS ?? null},
       ${input.llmCalls ?? null}, ${input.toolCalls ?? null}, ${input.haveCaseCount ?? null},
       ${input.checkpointUsed ?? null}, ${input.leanToolchain ?? null},
       ${input.mathlibVersion ?? null}, ${input.finalProof ?? null}, ${input.error ?? null},
       ${input.bridgeBuild ?? null}, ${input.notes ?? null})
    RETURNING id;
  `;
  return rows[0].id as string;
}

export async function listStrongholdRuns(
  limit = 500,
): Promise<Record<string, unknown>[]> {
  await ensureTables();
  const { rows } = await sql`
    SELECT * FROM leak_stronghold_runs ORDER BY created_at DESC LIMIT ${limit};
  `;
  return rows;
}

// Minimal CSV serializer (no external dep): comma-separated, double-quote
// escaped, CRLF rows — importable straight into Sheets/Excel/pandas for the
// plots this data exists for.
export function toCsv(rows: Record<string, unknown>[]): string {
  if (rows.length === 0) return '';
  const cols = Object.keys(rows[0]);
  const esc = (v: unknown): string => {
    if (v == null) return '';
    const s =
      v instanceof Date
        ? v.toISOString()
        : typeof v === 'object'
          ? JSON.stringify(v)
          : String(v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [cols.join(',')];
  for (const r of rows) lines.push(cols.map((c) => esc(r[c])).join(','));
  return lines.join('\r\n');
}
