import type { NextRequest } from 'next/server';

import { authenticateWorker } from '@/lib/leak/worker-auth';
import { completeJob, failJob, getJobById } from '@/lib/db/leak-queries';
import { deductCredits } from '@/lib/db/queries';


// POST /api/worker/complete
//   proved: { jobId, workerId, proof, tokensInput?, tokensOutput?, modelId? }
//   failed: { jobId, workerId, error,  tokensInput?, tokensOutput?, modelId? }
//
// On a proof we capture the quoted credits; on a failure we charge nothing
// (the money-back guarantee is simply "never deduct on failure").
export async function POST(request: NextRequest) {
  if (!authenticateWorker(request)) {
    return Response.json({ error: 'unauthorized' }, { status: 401 });
  }

  const body = await request.json().catch(() => ({}));
  const jobId = body?.jobId;
  const workerId = body?.workerId;
  if (typeof jobId !== 'string' || typeof workerId !== 'string') {
    return Response.json(
      { error: 'jobId and workerId required' },
      { status: 400 },
    );
  }

  const tokensInput =
    typeof body?.tokensInput === 'number' ? body.tokensInput : null;
  const tokensOutput =
    typeof body?.tokensOutput === 'number' ? body.tokensOutput : null;
  const modelId = typeof body?.modelId === 'string' ? body.modelId : null;

  // Verify this worker actually holds the lease before doing anything.
  const current = await getJobById({ id: jobId });
  if (!current) return Response.json({ error: 'not_found' }, { status: 404 });
  if (current.leasedBy !== workerId) {
    return Response.json({ error: 'not_lease_holder' }, { status: 409 });
  }

  // ---- Failure path: mark failed, charge nothing. ----
  if (typeof body?.error === 'string' && body.error) {
    const row = await failJob({
      id: jobId,
      workerId,
      error: body.error.slice(0, 8_000),
      tokensInput,
      tokensOutput,
      modelId,
    });
    return Response.json({ ok: true, status: row?.status ?? 'failed' });
  }

  // ---- Success path: require a proof, capture credits, then mark proved. ----
  if (typeof body?.proof !== 'string' || !body.proof.trim()) {
    return Response.json(
      { error: 'proof or error required' },
      { status: 400 },
    );
  }

  const quoted = current.quotedCredits ?? 0;
  let charged = 0;
  if (quoted > 0) {
    try {
      await deductCredits({
        userId: current.userId,
        amount: quoted,
        description: `Proof delivered for job ${jobId}`,
        tokensInput: tokensInput ?? undefined,
        tokensOutput: tokensOutput ?? undefined,
        modelId: modelId ?? undefined,
      });
      charged = quoted;
    } catch {
      // Balance moved between submit and capture. Deliver the proof anyway and
      // leave it uncharged rather than losing the (already-completed) work;
      // the operator can reconcile from the chargedCredits=0 audit trail.
      charged = 0;
    }
  }

  const row = await completeJob({
    id: jobId,
    workerId,
    proof: body.proof,
    chargedCredits: charged,
    tokensInput,
    tokensOutput,
    modelId,
  });

  return Response.json({
    ok: true,
    status: row?.status ?? 'proved',
    chargedCredits: charged,
  });
}
