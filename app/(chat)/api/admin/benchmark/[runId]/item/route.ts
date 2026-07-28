import { auth } from '@/app/(auth)/auth';
import { isAdminEmail } from '@/lib/admin';
import {
  TERMINAL_STATUSES,
  recordOutcome,
  releaseItem,
  requeueItem,
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

// PATCH one claimed item. Distinguished by `action`:
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
//   { action: 'checkpoint', itemId, skeleton, filled, total }  — persist a
//     have-tree partial-skeleton checkpoint without changing status.
export async function PATCH(request: Request) {
  if (!(await requireAdmin())) {
    return Response.json({ error: 'forbidden' }, { status: 403 });
  }
  const body = await request.json().catch(() => null);
  const itemId = body?.itemId;
  if (typeof itemId !== 'string' || !itemId) {
    return Response.json({ error: 'itemId required' }, { status: 400 });
  }
  try {
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
