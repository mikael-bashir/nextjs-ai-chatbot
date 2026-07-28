import { auth } from '@/app/(auth)/auth';
import { isAdminEmail } from '@/lib/admin';
import {
  deleteRiverRun,
  listRiverRuns,
  toCsv,
} from '@/lib/db/research-queries';

// Leak River Vintage (Stone + oversight watchers) research telemetry. Rows
// live in leak_river_runs — same columns as the River family plus the watcher
// counters — but are surfaced as their OWN table: vintage is a separate
// ablation branch off Stone and must not be averaged into the
// stone→gate→delta ladder. Writes arrive via the shared River POST (the
// pipeline posts every river-* row there); this route reads and prunes the
// vintage slice.
//   GET    ?format=csv → CSV export for plotting; otherwise JSON { rows }
//   DELETE ?id=<uuid> → remove one bad/corrupted row
async function requireAdmin() {
  const session = await auth();
  return isAdminEmail(session?.user?.email) ? session : null;
}

export async function GET(request: Request) {
  if (!(await requireAdmin())) {
    return Response.json({ error: 'forbidden' }, { status: 403 });
  }
  const url = new URL(request.url);
  try {
    const rows = await listRiverRuns(
      Math.min(5000, Number(url.searchParams.get('limit')) || 500),
      'vintage',
    );
    if (url.searchParams.get('format') === 'csv') {
      return new Response(toCsv(rows), {
        headers: {
          'content-type': 'text/csv; charset=utf-8',
          'content-disposition':
            'attachment; filename="leak-river-vintage-runs.csv"',
        },
      });
    }
    return Response.json({ rows });
  } catch (error) {
    console.error('research/vintage GET error:', error);
    return Response.json({ error: 'internal' }, { status: 500 });
  }
}

export async function DELETE(request: Request) {
  if (!(await requireAdmin())) {
    return Response.json({ error: 'forbidden' }, { status: 403 });
  }
  const id = new URL(request.url).searchParams.get('id');
  if (!id) return Response.json({ error: 'id required' }, { status: 400 });
  try {
    const deleted = await deleteRiverRun(id);
    if (!deleted) return Response.json({ error: 'not found' }, { status: 404 });
    return Response.json({ ok: true });
  } catch (error) {
    console.error('research/vintage DELETE error:', error);
    return Response.json({ error: 'internal' }, { status: 500 });
  }
}
