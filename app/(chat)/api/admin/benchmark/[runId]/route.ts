import { auth } from '@/app/(auth)/auth';
import { isAdminEmail } from '@/lib/admin';
import {
  getRun,
  listItems,
  deleteRun,
  reclaimStaleRunning,
} from '@/lib/db/benchmark-queries';

async function requireAdmin() {
  const session = await auth();
  return isAdminEmail(session?.user?.email) ? session : null;
}

// GET → run + all items. Reclaims any item stranded `running` by a closed tab
// or crashed session BEFORE reading, so a resumed run never leaks a slot.
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ runId: string }> },
) {
  if (!(await requireAdmin())) {
    return Response.json({ error: 'forbidden' }, { status: 403 });
  }
  const { runId } = await params;
  try {
    const run = await getRun(runId);
    if (!run) return Response.json({ error: 'not found' }, { status: 404 });
    await reclaimStaleRunning(runId);
    const items = await listItems(runId);
    return Response.json({ run, items });
  } catch (error) {
    console.error('benchmark run GET error:', error);
    return Response.json({ error: 'internal' }, { status: 500 });
  }
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ runId: string }> },
) {
  if (!(await requireAdmin())) {
    return Response.json({ error: 'forbidden' }, { status: 403 });
  }
  const { runId } = await params;
  try {
    await deleteRun(runId);
    return Response.json({ ok: true });
  } catch (error) {
    console.error('benchmark run DELETE error:', error);
    return Response.json({ error: 'internal' }, { status: 500 });
  }
}
