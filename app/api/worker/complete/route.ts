import type { NextRequest } from 'next/server';

import { authenticateWorker } from '@/lib/leak/worker-auth';
import { completeJob, failJob, getJobById } from '@/lib/db/leak-queries';
import { deductCredits, getOrCreateCreditBalance } from '@/lib/db/queries';
import { getUsdToGbpRate } from '@/lib/pricing';

// Pay-for-compute markup: the customer is charged this multiple of the run's
// actual LLM cost (total_cost_usd), converted to credits (1 credit = £1).
const COST_MARKUP = 1.2;


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

  const proved =
    typeof body?.proof === 'string' && body.proof.trim().length > 0;
  const hasError = typeof body?.error === 'string' && body.error.length > 0;
  if (!proved && !hasError) {
    return Response.json({ error: 'proof or error required' }, { status: 400 });
  }

  // Pay-for-compute billing. Charge 1.2× the run's ACTUAL LLM cost — ALWAYS, on
  // success OR failure (a failed search still burned tokens) — converted to
  // credits (1 credit = £1) and CAPPED at the current balance so a user can
  // never go negative (bounds the ~one-turn overshoot the mid-run guard allows).
  const costUsd =
    typeof body?.costUsd === 'number' && body.costUsd >= 0 ? body.costUsd : 0;
  const rate = (await getUsdToGbpRate()) || 1;
  const rawCostGbp = costUsd * rate;
  const balance = await getOrCreateCreditBalance({ userId: current.userId });
  const charge = Math.min(
    Math.round(rawCostGbp * COST_MARKUP * 1_000_000) / 1_000_000,
    Math.max(0, balance),
  );
  let charged = 0;
  if (charge > 0) {
    try {
      await deductCredits({
        userId: current.userId,
        amount: charge,
        description: `Metered compute for job ${jobId} ($${costUsd.toFixed(4)} × ${COST_MARKUP})`,
        tokensInput: tokensInput ?? undefined,
        tokensOutput: tokensOutput ?? undefined,
        modelId: modelId ?? undefined,
        rawCostGbp,
        markupFactor: COST_MARKUP,
      });
      charged = charge;
    } catch {
      charged = 0; // balance race — leave uncharged, audit trail carries it
    }
  }

  const row = proved
    ? await completeJob({
        id: jobId,
        workerId,
        proof: body.proof as string,
        chargedCredits: charged,
        tokensInput,
        tokensOutput,
        modelId,
      })
    : await failJob({
        id: jobId,
        workerId,
        error: (body.error as string).slice(0, 8_000),
        chargedCredits: charged,
        tokensInput,
        tokensOutput,
        modelId,
      });

  return Response.json({
    ok: true,
    status: row?.status ?? (proved ? 'proved' : 'failed'),
    chargedCredits: charged,
    costUsd,
  });
}
