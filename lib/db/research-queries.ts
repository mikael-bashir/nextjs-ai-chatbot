import 'server-only';

import { sql } from '@vercel/postgres';

if (!process.env.POSTGRES_URL) {
  throw new Error('POSTGRES_URL environment variable is not set.');
}

// Research telemetry for the two prover systems under comparison this round:
//   Leak River      — the Goedel-Architect-style blueprint pipeline (Grok driver).
//   Leak Stronghold — the existing Claude-driven strategies (hacker/pantograph/
//                     librarian/sketch/brute/have/have-tree, single-agent or
//                     decomposed).
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
      points               integer,
      theorem_name         text,
      sorried_theorem      text,
      model                varchar(64),
      nl_seed_used         boolean,
      verified             boolean,
      refuted              boolean,
      cost_usd             double precision,
      cost_cap_hit         boolean,
      compute_budget_ms    integer,
      time_elapsed_s       integer,
      llm_calls            integer,
      tool_calls           integer,
      blueprint_iterations integer,
      nodes_total          integer,
      nodes_solved         integer,
      nodes_forfeited      integer,
      nodes_negated        integer,
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
      points            integer,
      theorem_name      text,
      sorried_theorem   text,
      model             varchar(64),
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
      final_proof       text,
      error             text,
      bridge_build      text,
      notes             text
    );
  `;
  tablesEnsured = true;
}

export interface RiverRunInput {
  generatedItemId?: string | null;
  problemTitle?: string | null;
  difficulty?: string | null;
  points?: number | null;
  theoremName?: string | null;
  sorriedTheorem: string;
  model?: string | null;
  nlSeedUsed?: boolean | null;
  verified: boolean;
  refuted?: boolean | null;
  costUsd?: number | null;
  costCapHit?: boolean | null;
  computeBudgetMs?: number | null;
  timeElapsedS?: number | null;
  llmCalls?: number | null;
  toolCalls?: number | null;
  blueprintIterations?: number | null;
  nodesTotal?: number | null;
  nodesSolved?: number | null;
  nodesForfeited?: number | null;
  nodesNegated?: number | null;
  finalProof?: string | null;
  error?: string | null;
  bridgeBuild?: string | null;
  notes?: string | null;
}

export async function insertRiverRun(input: RiverRunInput): Promise<string> {
  await ensureTables();
  const { rows } = await sql`
    INSERT INTO leak_river_runs
      (generated_item_id, problem_title, difficulty, points, theorem_name,
       sorried_theorem, model, nl_seed_used, verified, refuted, cost_usd,
       cost_cap_hit, compute_budget_ms, time_elapsed_s, llm_calls, tool_calls,
       blueprint_iterations, nodes_total, nodes_solved, nodes_forfeited,
       nodes_negated, final_proof, error, bridge_build, notes)
    VALUES
      (${input.generatedItemId ?? null}, ${input.problemTitle ?? null},
       ${input.difficulty ?? null}, ${input.points ?? null}, ${input.theoremName ?? null},
       ${input.sorriedTheorem}, ${input.model ?? null}, ${input.nlSeedUsed ?? null},
       ${input.verified}, ${input.refuted ?? null}, ${input.costUsd ?? null},
       ${input.costCapHit ?? null}, ${input.computeBudgetMs ?? null},
       ${input.timeElapsedS ?? null}, ${input.llmCalls ?? null}, ${input.toolCalls ?? null},
       ${input.blueprintIterations ?? null}, ${input.nodesTotal ?? null},
       ${input.nodesSolved ?? null}, ${input.nodesForfeited ?? null},
       ${input.nodesNegated ?? null}, ${input.finalProof ?? null}, ${input.error ?? null},
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

export interface StrongholdRunInput {
  generatedItemId?: string | null;
  problemTitle?: string | null;
  difficulty?: string | null;
  points?: number | null;
  theoremName?: string | null;
  sorriedTheorem: string;
  model?: string | null;
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
      (generated_item_id, problem_title, difficulty, points, theorem_name,
       sorried_theorem, model, strategy, verified, refuted, cost_usd,
       compute_budget_ms, time_elapsed_s, llm_calls, tool_calls,
       have_case_count, checkpoint_used, final_proof, error, bridge_build, notes)
    VALUES
      (${input.generatedItemId ?? null}, ${input.problemTitle ?? null},
       ${input.difficulty ?? null}, ${input.points ?? null}, ${input.theoremName ?? null},
       ${input.sorriedTheorem}, ${input.model ?? null}, ${input.strategy ?? null},
       ${input.verified}, ${input.refuted ?? null}, ${input.costUsd ?? null},
       ${input.computeBudgetMs ?? null}, ${input.timeElapsedS ?? null},
       ${input.llmCalls ?? null}, ${input.toolCalls ?? null}, ${input.haveCaseCount ?? null},
       ${input.checkpointUsed ?? null}, ${input.finalProof ?? null}, ${input.error ?? null},
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
