import { auth } from '@/app/(auth)/auth';
import { isAdminEmail } from '@/lib/admin';
import { benchmarkById } from '@/lib/benchmarks';
import {
  TERMINAL_STATUSES,
  addItem,
  addItems,
  getRun,
  recordOutcome,
  releaseItem,
  removeItem,
  requeueItem,
  resetItemFresh,
  retryItem,
  saveCheckpoint,
  skipItem,
  type ItemOutcomePatch,
  type ItemStatus,
} from '@/lib/db/benchmark-queries';

async function requireAdmin() {
  const session = await auth();
  return isAdminEmail(session?.user?.email) ? session : null;
}

// PATCH one item, or add/remove queue entries. Distinguished by `action`:
//   { action: 'add', problemId }  — add ONE problem from the run's own
//     benchmark pool to the queue (looked up server-side, never trusting a
//     client-supplied statement). Idempotent: re-adding an already-queued
//     problem is a no-op, not an error.
//   { action: 'add_many', problemIds: string[] }  — batch form (multi-select /
//     "add all"). Returns how many were actually new.
//   { action: 'remove', itemId }  — delete a queue entry outright, but ONLY
//     while it's still `pending` — this is "drag it out before you run it",
//     not a way to erase a scored or in-flight attempt (use `skip` for that).
//   { action: 'outcome', itemId, status, proof?, costUsd?, metrics?, ... } — a
//     completed attempt (proved / refuted / unsolved) — always a genuine result.
//   { action: 'release', itemId }  — hand the claim back to `pending` without
//     scoring it, because the attempt was aborted by an infra/quota hiccup
//     (bridge unreachable, Claude Max session limit), not a real prover miss.
//   { action: 'retry', itemId }  — back to `pending` KEEPING the attempt count,
//     because this attempt genuinely failed on this problem and the count is
//     what the auto-skip threshold reads.
//   { action: 'skip', itemId, reason? }  — give up on this problem without
//     scoring it as a prover miss, after repeated non-catastrophic failures.
//   { action: 'requeue', itemId }  — put a finished/skipped item back in the
//     queue so it is attempted again.
//   { action: 'reset_fresh', itemId }  — like requeue, but ALSO clears the
//     banked checkpoint and attempt count. Every other resume path keeps the
//     checkpoint on purpose (so a have-tree/have-surround item continues its
//     partial skeleton across a lapsed session); this is the escape hatch for
//     when the operator wants the SELECTED STRATEGY to run for real again —
//     a live checkpoint short-circuits dispatch straight to the flat single-
//     context finisher regardless of strategy. Scoped to one item; every
//     other item in the run (proved or not) is untouched.
//   { action: 'checkpoint', itemId, skeleton, filled, total }  — persist a
//     have-tree partial-skeleton checkpoint without changing status.
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ runId: string }> },
) {
  if (!(await requireAdmin())) {
    return Response.json({ error: 'forbidden' }, { status: 403 });
  }
  const { runId } = await params;
  const body = await request.json().catch(() => null);
  try {
    // These two create/remove queue entries by problemId, not itemId — handle
    // them before the itemId gate below applies to everything else.
    if (body?.action === 'add') {
      const problemId = body.problemId;
      if (typeof problemId !== 'string' || !problemId) {
        return Response.json({ error: 'problemId required' }, { status: 400 });
      }
      const run = await getRun(runId);
      if (!run) return Response.json({ error: 'not found' }, { status: 404 });
      const problem = benchmarkById(run.benchmark)?.problems.find(
        (p) => p.id === problemId,
      );
      if (!problem) {
        return Response.json({ error: 'unknown problem' }, { status: 400 });
      }
      const item = await addItem(runId, problem);
      return Response.json({ ok: true, item });
    }
    if (body?.action === 'add_many') {
      const ids = Array.isArray(body.problemIds)
        ? (body.problemIds as unknown[]).filter(
            (x): x is string => typeof x === 'string',
          )
        : [];
      if (!ids.length) {
        return Response.json({ error: 'problemIds required' }, { status: 400 });
      }
      const run = await getRun(runId);
      if (!run) return Response.json({ error: 'not found' }, { status: 404 });
      const pool = benchmarkById(run.benchmark)?.problems ?? [];
      const idSet = new Set(ids);
      const problems = pool.filter((p) => idSet.has(p.id));
      const added = await addItems(runId, problems);
      return Response.json({ ok: true, added });
    }

    const itemId = body?.itemId;
    if (typeof itemId !== 'string' || !itemId) {
      return Response.json({ error: 'itemId required' }, { status: 400 });
    }
    if (body.action === 'remove') {
      const removed = await removeItem(itemId);
      return removed
        ? Response.json({ ok: true })
        : Response.json(
            { error: 'only a pending item can be removed from the queue' },
            { status: 409 },
          );
    }
    if (body.action === 'release') {
      await releaseItem(itemId);
      return Response.json({ ok: true });
    }
    if (body.action === 'retry') {
      await retryItem(itemId);
      return Response.json({ ok: true });
    }
    if (body.action === 'skip') {
      await skipItem(
        itemId,
        typeof body.reason === 'string' ? body.reason.slice(0, 2000) : null,
      );
      return Response.json({ ok: true });
    }
    if (body.action === 'requeue') {
      await requeueItem(itemId);
      return Response.json({ ok: true });
    }
    if (body.action === 'reset_fresh') {
      await resetItemFresh(itemId);
      return Response.json({ ok: true });
    }
    if (body.action === 'checkpoint') {
      if (typeof body.skeleton !== 'string') {
        return Response.json({ error: 'skeleton required' }, { status: 400 });
      }
      await saveCheckpoint(itemId, {
        skeleton: body.skeleton,
        filled: Number(body.filled) || 0,
        total: Number(body.total) || 0,
      });
      return Response.json({ ok: true });
    }
    if (body.action === 'outcome') {
      if (!TERMINAL_STATUSES.includes(body.status as ItemStatus)) {
        return Response.json({ error: 'invalid status' }, { status: 400 });
      }
      const patch: ItemOutcomePatch = {
        status: body.status as ItemStatus,
        metrics:
          body.metrics && typeof body.metrics === 'object' ? body.metrics : null,
        researchRowId:
          typeof body.researchRowId === 'string' ? body.researchRowId : null,
        proof: body.proof ?? null,
        costUsd: body.costUsd == null ? null : Number(body.costUsd),
        refuted: body.refuted ?? null,
        counterexample: body.counterexample ?? null,
        errorMessage: body.errorMessage ?? null,
        proofCheckpoint: body.proofCheckpoint ?? null,
        proofCheckpointFilled:
          body.proofCheckpointFilled == null ? null : Number(body.proofCheckpointFilled),
        proofCheckpointTotal:
          body.proofCheckpointTotal == null ? null : Number(body.proofCheckpointTotal),
      };
      await recordOutcome(itemId, patch);
      return Response.json({ ok: true });
    }
    return Response.json({ error: 'unknown action' }, { status: 400 });
  } catch (error) {
    console.error('benchmark item PATCH error:', error);
    return Response.json({ error: 'internal' }, { status: 500 });
  }
}
