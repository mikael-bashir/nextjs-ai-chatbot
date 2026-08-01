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
  // Idempotent migrations for tables created by an earlier version of this file
  // (CREATE TABLE IF NOT EXISTS won't alter an existing one).
  for (const col of [
    // The budget this run was configured with, so a row stays interpretable
    // long after the UI defaults have moved on.
    'compute_budget_ms integer',
    'max_iters integer',
  ]) {
    await sql.query(`ALTER TABLE benchmark_runs ADD COLUMN IF NOT EXISTS ${col}`);
  }
  for (const col of [
    // Full ProverMetrics snapshot from the terminal `done` frame — the same
    // numbers the research row carries, kept per item so a run is self-
    // contained even if the research tables are later pruned.
    'metrics jsonb',
    // The research row this attempt filed (leak_river_runs / _ultra_ / _stronghold_).
    'research_row_id uuid',
    // Ordering key: the dataset's own sequence, so FATE-X (which is ordered by
    // increasing difficulty) is attempted in that order rather than by id text.
    'seq integer',
  ]) {
    await sql.query(`ALTER TABLE benchmark_items ADD COLUMN IF NOT EXISTS ${col}`);
  }
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
  computeBudgetMs: number | null;
  maxIters: number | null;
  createdAt: Date;
}

export interface BenchmarkRunSummary extends BenchmarkRunRow {
  pending: number;
  running: number;
  proved: number;
  refuted: number;
  unsolved: number;
  /** Attempts abandoned after repeated non-catastrophic failures. */
  skipped: number;
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
  /** Terminal ProverMetrics snapshot for this attempt (null until it finishes). */
  metrics: Record<string, unknown> | null;
  researchRowId: string | null;
  seq: number | null;
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
    metrics: (r.metrics as Record<string, unknown>) ?? null,
    researchRowId: (r.research_row_id as string) ?? null,
    seq: r.seq == null ? null : Number(r.seq),
    startedAt: d(r.started_at),
    finishedAt: d(r.finished_at),
    updatedAt: new Date(r.updated_at as string),
  };
}

function toRun(r: Record<string, unknown>): BenchmarkRunRow {
  return {
    id: r.id as string,
    benchmark: r.benchmark as string,
    label: r.label as string,
    model: (r.model as string) ?? null,
    strategy: (r.strategy as string) ?? null,
    decompose: !!r.decompose,
    total: Number(r.total),
    computeBudgetMs: r.compute_budget_ms == null ? null : Number(r.compute_budget_ms),
    maxIters: r.max_iters == null ? null : Number(r.max_iters),
    createdAt: new Date(r.created_at as string),
  };
}

export async function createRun(input: {
  benchmark: string;
  label: string;
  model: string | null;
  strategy: string | null;
  decompose: boolean;
  computeBudgetMs?: number | null;
  maxIters?: number | null;
  problems: { id: string; statement: string; informal: string | null }[];
}): Promise<BenchmarkRunRow> {
  await ensureTables();
  const { rows } = await sql`
    INSERT INTO benchmark_runs
      (benchmark, label, model, strategy, decompose, total, compute_budget_ms, max_iters)
    VALUES (${input.benchmark}, ${input.label}, ${input.model}, ${input.strategy},
            ${input.decompose}, ${input.problems.length},
            ${input.computeBudgetMs ?? null}, ${input.maxIters ?? null})
    RETURNING id, benchmark, label, model, strategy, decompose, total,
              compute_budget_ms, max_iters, created_at;
  `;
  const run = rows[0];
  // Seed every item up front (all `pending`) so the run's progress is durable
  // and resumable from the very first claim — there is no separate "start"
  // step that could be skipped or lost. `seq` preserves the dataset's own
  // ordering (FATE-X is sorted by increasing difficulty), which is what the
  // claim order and every "resume from problem N" control key off.
  for (const [i, p] of input.problems.entries()) {
    await sql`
      INSERT INTO benchmark_items (run_id, problem_id, statement, informal, seq)
      VALUES (${run.id}, ${p.id}, ${p.statement}, ${p.informal}, ${i});
    `;
  }
  return toRun(run);
}

// ── Incremental queue building (ACG-style: add exactly the problems you want,
// in whatever order you pick them, rather than bulk-seeding at creation) ──────
// `seq` is assigned as the next free slot so processing order is INSERTION
// order, not the dataset's own order — picking problem #80 before #5 means #80
// runs first. `ON CONFLICT DO NOTHING` makes re-adding an already-queued
// problem a harmless no-op instead of a unique-index error.

/** Add one problem to a run's queue. Returns the new (or already-existing) row. */
export async function addItem(
  runId: string,
  problem: { id: string; statement: string; informal: string | null },
): Promise<BenchmarkItemRow> {
  await ensureTables();
  const { rows } = await sql`
    INSERT INTO benchmark_items (run_id, problem_id, statement, informal, seq)
    VALUES (
      ${runId}, ${problem.id}, ${problem.statement}, ${problem.informal},
      (SELECT coalesce(max(seq), -1) + 1 FROM benchmark_items WHERE run_id = ${runId})
    )
    ON CONFLICT (run_id, problem_id) DO NOTHING
    RETURNING *;
  `;
  if (rows.length) return toItem(rows[0]);
  // Already queued — return the existing row so the caller still gets a result.
  const existing = await sql`
    SELECT * FROM benchmark_items WHERE run_id = ${runId} AND problem_id = ${problem.id};
  `;
  return toItem(existing.rows[0]);
}

/** Add many problems in one call (the "add all" / multi-select actions). */
export async function addItems(
  runId: string,
  problems: { id: string; statement: string; informal: string | null }[],
): Promise<number> {
  await ensureTables();
  let added = 0;
  // Sequential, not parallel: each insert reads the CURRENT max(seq) for this
  // run, so concurrent inserts racing that subquery could collide on the same
  // seq value. A benchmark's "add all" batch is at most a few hundred rows —
  // fast enough sequentially that this is not worth a more complex upsert.
  for (const p of problems) {
    const { rows } = await sql`
      INSERT INTO benchmark_items (run_id, problem_id, statement, informal, seq)
      VALUES (
        ${runId}, ${p.id}, ${p.statement}, ${p.informal},
        (SELECT coalesce(max(seq), -1) + 1 FROM benchmark_items WHERE run_id = ${runId})
      )
      ON CONFLICT (run_id, problem_id) DO NOTHING
      RETURNING id;
    `;
    if (rows.length) added++;
  }
  return added;
}

/**
 * Remove one item from the queue — but ONLY while it's still `pending`, so a
 * click can never destroy a running attempt or a scored result (that's what
 * `skip`/`requeue` are for). Returns false (no-op) if the item wasn't pending.
 */
export async function removeItem(itemId: string): Promise<boolean> {
  await ensureTables();
  const { rowCount } = await sql`
    DELETE FROM benchmark_items WHERE id = ${itemId} AND status = 'pending';
  `;
  return (rowCount ?? 0) > 0;
}

export async function listRuns(): Promise<BenchmarkRunSummary[]> {
  await ensureTables();
  const { rows } = await sql`
    SELECT r.id, r.benchmark, r.label, r.model, r.strategy, r.decompose,
           count(i.id) AS total,
           r.compute_budget_ms, r.max_iters, r.created_at,
           count(*) FILTER (WHERE i.status = 'pending')  AS pending,
           count(*) FILTER (WHERE i.status = 'running')  AS running,
           count(*) FILTER (WHERE i.status = 'proved')   AS proved,
           count(*) FILTER (WHERE i.status = 'refuted')  AS refuted,
           count(*) FILTER (WHERE i.status = 'unsolved') AS unsolved,
           count(*) FILTER (WHERE i.status = 'skipped')  AS skipped,
           coalesce(sum(i.cost_usd), 0) AS cost_usd
    FROM benchmark_runs r
    LEFT JOIN benchmark_items i ON i.run_id = r.id
    GROUP BY r.id
    ORDER BY r.created_at DESC;
  `;
  return rows.map((r) => ({
    ...toRun(r),
    pending: Number(r.pending),
    running: Number(r.running),
    proved: Number(r.proved),
    refuted: Number(r.refuted),
    unsolved: Number(r.unsolved),
    skipped: Number(r.skipped),
    costUsd: Number(r.cost_usd),
  }));
}

export async function getRun(runId: string): Promise<BenchmarkRunRow | null> {
  await ensureTables();
  const { rows } = await sql`
    SELECT r.id, r.benchmark, r.label, r.model, r.strategy, r.decompose,
           (SELECT count(*) FROM benchmark_items WHERE run_id = r.id) AS total,
           r.compute_budget_ms, r.max_iters, r.created_at
    FROM benchmark_runs r WHERE r.id = ${runId};
  `;
  return rows.length ? toRun(rows[0]) : null;
}

// Dataset order everywhere: `seq` when present (rows seeded before that column
// existed have none), falling back to problem_id so old runs still sort stably.
export async function listItems(runId: string): Promise<BenchmarkItemRow[]> {
  await ensureTables();
  const { rows } = await sql`
    SELECT * FROM benchmark_items
    WHERE run_id = ${runId}
    ORDER BY seq ASC NULLS LAST, problem_id ASC;
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
      ORDER BY seq ASC NULLS LAST, problem_id ASC
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
//
// The claim incremented `attempts`; give it back. `attempts` is what the
// auto-skip threshold reads, and a laptop lid or a quota reset is not the
// problem's fault — counting it would burn a real retry.
export async function releaseItem(itemId: string): Promise<void> {
  await ensureTables();
  await sql`
    UPDATE benchmark_items
    SET status = 'pending', attempts = greatest(attempts - 1, 0), updated_at = now()
    WHERE id = ${itemId};
  `;
}

// Hand a claimed item back to `pending` KEEPING its attempt count. Used when the
// attempt genuinely failed on THIS problem and is worth one more try: the count
// has to survive, because it is what the auto-skip threshold reads. (releaseItem
// deliberately gives the attempt back — using it here would reset the counter
// every pass and the run would retry the same problem forever.)
export async function retryItem(itemId: string): Promise<void> {
  await ensureTables();
  await sql`
    UPDATE benchmark_items SET status = 'pending', updated_at = now() WHERE id = ${itemId};
  `;
}

// Reset ONE item to a genuinely clean slate: every other resume path (retry,
// release, requeue, skip→requeue) deliberately KEEPS proof_checkpoint, so a
// have-tree/have-surround item with banked partial progress resumes straight
// into the single-context finisher — bypassing the planner + minion path
// regardless of which strategy is selected (ctx.seed short-circuits dispatch
// before the strategy switch is ever read). That's correct for continuing a
// long run across a lapsed session, but wrong when the operator wants to see
// the SELECTED STRATEGY'S real behavior again on this problem.
//
// This clears the checkpoint (and the attempt count, since "fresh" means
// fresh) so the next claim runs the real planner/minion path. Scoped to a
// single itemId — every other item in the run, proved or not, is untouched.
export async function resetItemFresh(itemId: string): Promise<void> {
  await ensureTables();
  await sql`
    UPDATE benchmark_items
    SET status = 'pending',
        error_message = NULL,
        finished_at = NULL,
        proof_checkpoint = NULL,
        proof_checkpoint_filled = NULL,
        proof_checkpoint_total = NULL,
        attempts = 0,
        updated_at = now()
    WHERE id = ${itemId};
  `;
}

/** Terminal states for one attempt. `skipped` = abandoned, never scored. */
export type ItemStatus = 'proved' | 'refuted' | 'unsolved' | 'skipped';
export const TERMINAL_STATUSES: ItemStatus[] = [
  'proved',
  'refuted',
  'unsolved',
  'skipped',
];

export interface ItemOutcomePatch {
  status: ItemStatus;
  proof?: string | null;
  costUsd?: number | null;
  refuted?: boolean | null;
  counterexample?: string | null;
  errorMessage?: string | null;
  proofCheckpoint?: string | null;
  proofCheckpointFilled?: number | null;
  proofCheckpointTotal?: number | null;
  /** Terminal ProverMetrics snapshot, stored verbatim. */
  metrics?: Record<string, unknown> | null;
  /** Id of the research row this attempt filed, when one was filed. */
  researchRowId?: string | null;
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
      metrics = ${patch.metrics ? JSON.stringify(patch.metrics) : null}::jsonb,
      research_row_id = ${patch.researchRowId ?? null},
      finished_at = now(),
      updated_at = now()
    WHERE id = ${itemId};
  `;
}

// ── Resume controls ─────────────────────────────────────────────────────────
// A benchmark pass is long and the bridge is a laptop: a run has to survive
// stopping, and the operator has to be able to say "go back and do those again".
// Every requeue clears the previous attempt's outcome but KEEPS `attempts`, so
// the auto-skip threshold still sees the history, and keeps the checkpoint, so
// a have-tree item resumes from its banked skeleton instead of from scratch.

/** Put one item back in the queue regardless of its current status. */
export async function requeueItem(itemId: string): Promise<void> {
  await ensureTables();
  await sql`
    UPDATE benchmark_items
    SET status = 'pending', error_message = NULL, finished_at = NULL, updated_at = now()
    WHERE id = ${itemId};
  `;
}

/**
 * Requeue every item in `statuses` (e.g. everything skipped, or every miss).
 * Returns how many were reset.
 */
export async function requeueByStatus(
  runId: string,
  statuses: string[],
): Promise<number> {
  await ensureTables();
  if (!statuses.length) return 0;
  // sql.query (not the tagged template) so the status list binds as a real
  // text[] — `= ANY($2)` cannot infer the element type from an untyped literal.
  const { rowCount } = await sql.query(
    `UPDATE benchmark_items
     SET status = 'pending', error_message = NULL, finished_at = NULL, updated_at = now()
     WHERE run_id = $1 AND status = ANY($2::text[]) AND status <> 'running'`,
    [runId, statuses],
  );
  return rowCount ?? 0;
}

/**
 * "Resume from this problem": make `problemId` the NEXT item the run claims,
 * and requeue everything after it in queue order.
 *
 * Both halves are required, and the second one is the whole point. Requeueing
 * the tail only ever ADDS to the pending set, while claimNextItem always takes
 * the LOWEST-seq pending item — so on its own this could move the start point
 * earlier but never later, and clicking "from here" on anything except the
 * earliest pending item silently did nothing. In the common mid-run state
 * (everything after the failure is still pending from the initial seeding)
 * it was a complete no-op: the pass restarted at the earliest pending item,
 * not at the one that was clicked.
 *
 * So anything still `pending` STRICTLY BEFORE the target is parked as
 * `skipped` — the existing vocabulary for "not attempted, not scored" — which
 * makes the target the lowest-seq pending row and therefore the next claim.
 * Items before it that already have a RESULT (proved/unsolved/refuted) keep
 * it; `running` is never touched; and parking is fully reversible with the
 * existing "requeue skipped" control.
 *
 * Returns both counts so the caller can report what actually happened.
 */
export async function requeueFrom(
  runId: string,
  problemId: string,
): Promise<{ requeued: number; parked: number }> {
  await ensureTables();
  // coalesce on BOTH sides: rows seeded before `seq` existed have none, and a
  // NULL anywhere in a row comparison makes the whole predicate NULL (so those
  // rows would silently never be matched).
  const parked = await sql`
    UPDATE benchmark_items
    SET status = 'skipped',
        error_message = ${`skipped — run resumed from ${problemId}`},
        finished_at = now(), updated_at = now()
    WHERE run_id = ${runId}
      AND status = 'pending'
      AND (coalesce(seq, 2147483647), problem_id) < (
        SELECT coalesce(seq, 2147483647), problem_id FROM benchmark_items
        WHERE run_id = ${runId} AND problem_id = ${problemId}
      );
  `;
  const requeued = await sql`
    UPDATE benchmark_items
    SET status = 'pending', error_message = NULL, finished_at = NULL, updated_at = now()
    WHERE run_id = ${runId}
      AND status <> 'running'
      AND (coalesce(seq, 2147483647), problem_id) >= (
        SELECT coalesce(seq, 2147483647), problem_id FROM benchmark_items
        WHERE run_id = ${runId} AND problem_id = ${problemId}
      );
  `;
  return { requeued: requeued.rowCount ?? 0, parked: parked.rowCount ?? 0 };
}

/**
 * Give up on one item without scoring it as a prover miss. Used when an attempt
 * keeps failing for a reason that is not the prover's fault (a statement that
 * will not elaborate on our toolchain, a daemon that times out on it every
 * time) — recording it as `unsolved` would understate the pass rate, and
 * leaving it `pending` would stall the run forever.
 */
export async function skipItem(
  itemId: string,
  reason: string | null,
): Promise<void> {
  await ensureTables();
  await sql`
    UPDATE benchmark_items
    SET status = 'skipped', error_message = ${reason},
        finished_at = now(), updated_at = now()
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
