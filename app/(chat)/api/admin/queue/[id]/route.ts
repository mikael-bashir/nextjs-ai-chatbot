import { auth } from '@/app/(auth)/auth';
import { isAdminEmail } from '@/lib/admin';
import {
  adminResolveProved,
  adminResolveFailed,
  getJobById,
} from '@/lib/db/leak-queries';
import { deductCredits } from '@/lib/db/queries';

// POST /api/admin/queue/:id — admin resolves a queued problem by hand.
//   proved: { proof: string }
//   failed: { error: string }
// On a proof we capture the quoted credits (same rule as the worker); on a
// failure the submitter is charged nothing.
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await auth();
  if (!isAdminEmail(session?.user?.email)) {
    return Response.json({ error: 'forbidden' }, { status: 403 });
  }

  const { id } = await params;
  const job = await getJobById({ id });
  if (!job) return Response.json({ error: 'not_found' }, { status: 404 });
  if (job.status === 'proved' || job.status === 'failed') {
    return Response.json({ error: 'already_resolved' }, { status: 409 });
  }

  const body = await request.json().catch(() => ({}));

  // Failure path.
  if (typeof body?.error === 'string' && body.error.trim()) {
    const row = await adminResolveFailed({
      id,
      error: body.error.trim().slice(0, 8_000),
    });
    return Response.json({ ok: true, status: row?.status ?? 'failed' });
  }

  // Success path — require a proof.
  if (typeof body?.proof !== 'string' || !body.proof.trim()) {
    return Response.json({ error: 'proof or error required' }, { status: 400 });
  }

  const quoted = job.quotedCredits ?? 0;
  let charged = 0;
  if (quoted > 0) {
    try {
      await deductCredits({
        userId: job.userId,
        amount: quoted,
        description: `Proof delivered (admin) for job ${id}`,
        modelId: 'admin',
      });
      charged = quoted;
    } catch {
      // Submitter can't cover it right now — deliver the proof uncharged.
      charged = 0;
    }
  }

  const row = await adminResolveProved({
    id,
    proof: body.proof,
    chargedCredits: charged,
    modelId: 'admin',
  });
  return Response.json({
    ok: true,
    status: row?.status ?? 'proved',
    chargedCredits: charged,
  });
}
