import { auth } from '@/app/(auth)/auth';
import { isAdminEmail } from '@/lib/admin';
import { claimNextItem } from '@/lib/db/benchmark-queries';

async function requireAdmin() {
  const session = await auth();
  return isAdminEmail(session?.user?.email) ? session : null;
}

// Atomically claim the next `pending` item for this run (row-locked, so two
// admin tabs — or a resumed session racing a still-open old one — never both
// grab the same problem). `item: null` means the run is complete.
export async function POST(
  _request: Request,
  { params }: { params: Promise<{ runId: string }> },
) {
  if (!(await requireAdmin())) {
    return Response.json({ error: 'forbidden' }, { status: 403 });
  }
  const { runId } = await params;
  try {
    const item = await claimNextItem(runId);
    return Response.json({ item });
  } catch (error) {
    console.error('benchmark claim error:', error);
    return Response.json({ error: 'internal' }, { status: 500 });
  }
}
