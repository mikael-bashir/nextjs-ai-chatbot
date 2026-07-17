import 'server-only';

import { sql } from '@vercel/postgres';

if (!process.env.POSTGRES_URL) {
  throw new Error('POSTGRES_URL environment variable is not set.');
}

// Admin-only capability benchmarking (e.g. miniF2F-test) — separate from the
// customer-facing ProblemJob queue and the CompeteMath generation pipeline.
// A "run" is one attempt at a named benchmark under a fixed model/strategy; its
// items are seeded up front (all `pending`) so the run is resumable across
// sessions — the admin's Claude Max usage can lapse mid-run and picking back up
// later just means claiming the next `pending` item. Snake_case, raw SQL, same
// inline-DDL convention as lib/db/cost-history-queries.ts.
let tableEnsured = false;
async function ensureTables(): Promise<void> {
  if (tableEnsured) return;
  await sql`
    CREATE TABLE IF NOT EXISTS benchmark_runs (
      id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      benchmark   varchar(64) NOT NULL,
      label       text NOT NULL,
      model       varchar(64),
      strategy    varchar(32),
      decompose   boolean NOT NULL DEFAULT false,
      total       integer NOT NULL,
      created_at  timestamptz NOT NULL DEFAULT now()
    );
  `;
  await sql`
    CREATE TABLE IF NOT EXISTS benchmark_items (
      id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      run_id                   uuid NOT NULL REFERENCES benchmark_runs(id) ON DELETE CASCADE,
      problem_id               varchar(160) NOT NULL,
      statement                text NOT NULL,
      informal                 text,
      status                   varchar(16) NOT NULL DEFAULT 'pending',
      proof                    text,
      cost_usd                 double precision,
      refuted                  boolean,
      counterexample           text,
      error_message            text,
      attempts                 integer NOT NULL DEFAULT 0,
      proof_checkpoint         text,
      proof_checkpoint_filled  integer,
      proof_checkpoint_total   integer,
      started_at               timestamptz,
      finished_at              timestamptz,
      updated_at               timestamptz NOT NULL DEFAULT now()
    );
  `;
  await sql`CREATE INDEX IF NOT EXISTS benchmark_items_run_status_idx ON benchmark_items (run_id, status);`;
  await sql`CREATE UNIQUE INDEX IF NOT EXISTS benchmark_items_run_problem_idx ON benchmark_items (run_id, problem_id);`;
  tableEnsured = true;
}

export interface BenchmarkRunRow {
  id: string;
  benchmark: string;
  label: string;
  model: string | null;
  strategy: string | null;
  decompose: boolean;
  total: number;
  createdAt: Date;
}

export interface BenchmarkRunSummary extends BenchmarkRunRow {
  pending: number;
  running: number;
  proved: number;
  refuted: number;
  unsolved: number;
  costUsd: number;
}

export interface BenchmarkItemRow {
  id: string;
  runId: string;
  problemId: string;
  statement: string;
  informal: string | null;
  status: string;
  proof: string | null;
  costUsd: number | null;
  refuted: boolean | null;
  counterexample: string | null;
  errorMessage: string | null;
  attempts: number;
  proofCheckpoint: string | null;
  proofCheckpointFilled: number | null;
  proofCheckpointTotal: number | null;
  startedAt: Date | null;
  finishedAt: Date | null;
  updatedAt: Date;
}

function toItem(r: Record<string, unknown>): BenchmarkItemRow {
  const d = (v: unknown) => (v == null ? null : new Date(v as string));
  return {
    id: r.id as string,
    runId: r.run_id as string,
    problemId: r.problem_id as string,
    statement: r.statement as string,
    informal: (r.informal as string) ?? null,
    status: r.status as string,
    proof: (r.proof as string) ?? null,
    costUsd: r.cost_usd == null ? null : Number(r.cost_usd),
    refuted: (r.refuted as boolean) ?? null,
    counterexample: (r.counterexample as string) ?? null,
    errorMessage: (r.error_message as string) ?? null,
    attempts: Number(r.attempts ?? 0),
    proofCheckpoint: (r.proof_checkpoint as string) ?? null,
    proofCheckpointFilled:
      r.proof_checkpoint_filled == null ? null : Number(r.proof_checkpoint_filled),
    proofCheckpointTotal:
      r.proof_checkpoint_total == null ? null : Number(r.proof_checkpoint_total),
    startedAt: d(r.started_at),
    finishedAt: d(r.finished_at),
    updatedAt: new Date(r.updated_at as string),
  };
}

export async function createRun(input: {
  benchmark: string;
  label: string;
  model: string | null;
  strategy: string | null;
  decompose: boolean;
  problems: { id: string; statement: string; informal: string | null }[];
}): Promise<BenchmarkRunRow> {
  await ensureTables();
  const { rows } = await sql`
    INSERT INTO benchmark_runs (benchmark, label, model, strategy, decompose, total)
    VALUES (${input.benchmark}, ${input.label}, ${input.model}, ${input.strategy},
            ${input.decompose}, ${input.problems.length})
    RETURNING id, benchmark, label, model, strategy, decompose, total, created_at;
  `;
  const run = rows[0];
  // Seed every item up front (all `pending`) so the run's progress is durable
  // and resumable from the very first claim — there is no separate "start"
  // step that could be skipped or lost.
  for (const p of input.problems) {
    await sql`
      INSERT INTO benchmark_items (run_id, problem_id, statement, informal)
      VALUES (${run.id}, ${p.id}, ${p.statement}, ${p.informal});
    `;
  }
  return {
    id: run.id as string,
    benchmark: run.benchmark as string,
    label: run.label as string,
    model: (run.model as string) ?? null,
    strategy: (run.strategy as string) ?? null,
    decompose: !!run.decompose,
    total: Number(run.total),
    createdAt: new Date(run.created_at as string),
  };
}

export async function listRuns(): Promise<BenchmarkRunSummary[]> {
  await ensureTables();
  const { rows } = await sql`
    SELECT r.id, r.benchmark, r.label, r.model, r.strategy, r.decompose, r.total, r.created_at,
           count(*) FILTER (WHERE i.status = 'pending')  AS pending,
           count(*) FILTER (WHERE i.status = 'running')  AS running,
           count(*) FILTER (WHERE i.status = 'proved')   AS proved,
           count(*) FILTER (WHERE i.status = 'refuted')  AS refuted,
           count(*) FILTER (WHERE i.status = 'unsolved') AS unsolved,
           coalesce(sum(i.cost_usd), 0) AS cost_usd
    FROM benchmark_runs r
    LEFT JOIN benchmark_items i ON i.run_id = r.id
    GROUP BY r.id
    ORDER BY r.created_at DESC;
  `;
  return rows.map((r) => ({
    id: r.id as string,
    benchmark: r.benchmark as string,
    label: r.label as string,
    model: (r.model as string) ?? null,
    strategy: (r.strategy as string) ?? null,
    decompose: !!r.decompose,
    total: Number(r.total),
    createdAt: new Date(r.created_at as string),
    pending: Number(r.pending),
    running: Number(r.running),
    proved: Number(r.proved),
    refuted: Number(r.refuted),
    unsolved: Number(r.unsolved),
    costUsd: Number(r.cost_usd),
  }));
}

export async function getRun(runId: string): Promise<BenchmarkRunRow | null> {
  await ensureTables();
  const { rows } = await sql`
    SELECT id, benchmark, label, model, strategy, decompose, total, created_at
    FROM benchmark_runs WHERE id = ${runId};
  `;
  if (!rows.length) return null;
  const r = rows[0];
  return {
    id: r.id as string,
    benchmark: r.benchmark as string,
    label: r.label as string,
    model: (r.model as string) ?? null,
    strategy: (r.strategy as string) ?? null,
    decompose: !!r.decompose,
    total: Number(r.total),
    createdAt: new Date(r.created_at as string),
  };
}

export async function listItems(runId: string): Promise<BenchmarkItemRow[]> {
  await ensureTables();
  const { rows } = await sql`
    SELECT * FROM benchmark_items WHERE run_id = ${runId} ORDER BY problem_id ASC;
  `;
  return rows.map(toItem);
}

export async function deleteRun(runId: string): Promise<void> {
  await ensureTables();
  await sql`DELETE FROM benchmark_runs WHERE id = ${runId};`;
}

// Reclaim items stranded `running` by a crashed/closed tab so a resumed run
// never permanently loses a slot. Call once when a run's page loads / on
// "Resume". Safe to call anytime — a genuinely in-flight item just gets
// reclaimed a beat early (the client will re-claim and continue).
export async function reclaimStaleRunning(runId: string): Promise<number> {
  await ensureTables();
  const { rowCount } = await sql`
    UPDATE benchmark_items SET status = 'pending', updated_at = now()
    WHERE run_id = ${runId} AND status = 'running';
  `;
  return rowCount ?? 0;
}

// Atomically claim the next pending item (row-locked so two admin tabs can
// never grab the same problem). Returns null when the run is complete.
export async function claimNextItem(runId: string): Promise<BenchmarkItemRow | null> {
  await ensureTables();
  const { rows } = await sql`
    UPDATE benchmark_items
    SET status = 'running', started_at = now(), attempts = attempts + 1, updated_at = now()
    WHERE id = (
      SELECT id FROM benchmark_items
      WHERE run_id = ${runId} AND status = 'pending'
      ORDER BY problem_id ASC
      LIMIT 1
      FOR UPDATE SKIP LOCKED
    )
    RETURNING *;
  `;
  return rows.length ? toItem(rows[0]) : null;
}

// Release a claimed item back to `pending` without recording an outcome — used
// when the attempt was aborted by an infra/quota hiccup (bridge unreachable,
// Claude Max session limit) rather than a genuine prover miss, so it is retried
// rather than scored as failed.
export async function releaseItem(itemId: string): Promise<void> {
  await ensureTables();
  await sql`
    UPDATE benchmark_items SET status = 'pending', updated_at = now() WHERE id = ${itemId};
  `;
}

export interface ItemOutcomePatch {
  status: 'proved' | 'refuted' | 'unsolved';
  proof?: string | null;
  costUsd?: number | null;
  refuted?: boolean | null;
  counterexample?: string | null;
  errorMessage?: string | null;
  proofCheckpoint?: string | null;
  proofCheckpointFilled?: number | null;
  proofCheckpointTotal?: number | null;
}

export async function recordOutcome(
  itemId: string,
  patch: ItemOutcomePatch,
): Promise<void> {
  await ensureTables();
  await sql`
    UPDATE benchmark_items SET
      status = ${patch.status},
      proof = ${patch.proof ?? null},
      cost_usd = ${patch.costUsd ?? null},
      refuted = ${patch.refuted ?? null},
      counterexample = ${patch.counterexample ?? null},
      error_message = ${patch.errorMessage ?? null},
      proof_checkpoint = ${patch.proofCheckpoint ?? null},
      proof_checkpoint_filled = ${patch.proofCheckpointFilled ?? null},
      proof_checkpoint_total = ${patch.proofCheckpointTotal ?? null},
      finished_at = now(),
      updated_at = now()
    WHERE id = ${itemId};
  `;
}

// Persist a checkpoint on an item WITHOUT changing its status (still `running`
// or being handed back to `pending`) — mirrors admin-pipeline's auto-save so a
// paused have-tree item resumes from its last banked skeleton, not from scratch.
export async function saveCheckpoint(
  itemId: string,
  checkpoint: { skeleton: string; filled: number; total: number },
): Promise<void> {
  await ensureTables();
  await sql`
    UPDATE benchmark_items SET
      proof_checkpoint = ${checkpoint.skeleton},
      proof_checkpoint_filled = ${checkpoint.filled},
      proof_checkpoint_total = ${checkpoint.total},
      updated_at = now()
    WHERE id = ${itemId};
  `;
}
