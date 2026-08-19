import { auth } from '@/app/(auth)/auth';
import { isAdminEmail } from '@/lib/admin';
import {
  deleteRiverRun,
  insertRiverRun,
  listRiverRuns,
  toCsv,
  type RiverRunInput,
} from '@/lib/db/research-queries';

// Leak River (Goedel-Architect-style blueprint pipeline) research telemetry.
//   GET    ?format=csv → CSV export for plotting; otherwise JSON { rows }
//   POST   { ...RiverRunInput } → { id }, one row per verification attempt
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
    );
    if (url.searchParams.get('format') === 'csv') {
      return new Response(toCsv(rows), {
        headers: {
          'content-type': 'text/csv; charset=utf-8',
          'content-disposition': 'attachment; filename="leak-river-runs.csv"',
        },
      });
    }
    return Response.json({ rows });
  } catch (error) {
    console.error('research/river GET error:', error);
    return Response.json({ error: 'internal' }, { status: 500 });
  }
}

export async function POST(request: Request) {
  if (!(await requireAdmin())) {
    return new Response(null, { status: 204 });
  }
  const body = (await request.json().catch(() => null)) as RiverRunInput | null;
  if (
    !body ||
    typeof body.sorriedTheorem !== 'string' ||
    typeof body.verified !== 'boolean'
  ) {
    return Response.json(
      { error: 'sorriedTheorem + verified required' },
      { status: 400 },
    );
  }
  try {
    const id = await insertRiverRun(body);
    return Response.json({ id });
  } catch (error) {
    console.error('research/river POST error:', error);
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
    console.error('research/river DELETE error:', error);
    return Response.json({ error: 'internal' }, { status: 500 });
  }
}
