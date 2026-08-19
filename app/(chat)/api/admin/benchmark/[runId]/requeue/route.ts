import { auth } from '@/app/(auth)/auth';
import { isAdminEmail } from '@/lib/admin';
import { requeueByStatus, requeueFrom } from '@/lib/db/benchmark-queries';

async function requireAdmin() {
  const session = await auth();
  return isAdminEmail(session?.user?.email) ? session : null;
}

// Bulk resume controls for a run. Two shapes:
//   { from: '<problemId>' }        — make that problem the NEXT one claimed and
//                                    requeue everything after it in queue order
//                                    ("resume from here"). Still-pending items
//                                    BEFORE it are parked as `skipped` so the
//                                    claim actually lands there; see
//                                    requeueFrom for why that is required.
//                                    Responds { requeued, parked }.
//   { statuses: ['skipped', ...] } — requeue every item currently in those
//                                    states (e.g. retry all skipped), which is
//                                    also how a parked item is brought back.
// Neither ever touches an item that is still `running`.
export async function POST(
  request: Request,
  { params }: { params: Promise<{ runId: string }> },
) {
  if (!(await requireAdmin())) {
    return Response.json({ error: 'forbidden' }, { status: 403 });
  }
  const { runId } = await params;
  const body = await request.json().catch(() => null);
  try {
    if (typeof body?.from === 'string' && body.from) {
      const { requeued, parked } = await requeueFrom(runId, body.from);
      return Response.json({ ok: true, requeued, parked });
    }
    if (Array.isArray(body?.statuses)) {
      const statuses = body.statuses.filter(
        (s: unknown): s is string =>
          typeof s === 'string' &&
          ['proved', 'refuted', 'unsolved', 'skipped', 'pending'].includes(s),
      );
      return Response.json({
        ok: true,
        requeued: await requeueByStatus(runId, statuses),
      });
    }
    return Response.json({ error: 'from or statuses required' }, { status: 400 });
  } catch (error) {
    console.error('benchmark requeue error:', error);
    return Response.json({ error: 'internal' }, { status: 500 });
  }
}
