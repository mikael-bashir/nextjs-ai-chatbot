import { auth } from '@/app/(auth)/auth';
import { isAdminEmail } from '@/lib/admin';
import {
  deleteStrongholdRun,
  insertStrongholdRun,
  listStrongholdRuns,
  toCsv,
  type StrongholdRunInput,
} from '@/lib/db/research-queries';

// Leak Stronghold (Claude-driven strategies) research telemetry.
//   GET    ?format=csv → CSV export for plotting; otherwise JSON { rows }
//   POST   { ...StrongholdRunInput } → { id }, one row per verification attempt
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
    const rows = await listStrongholdRuns(
      Math.min(5000, Number(url.searchParams.get('limit')) || 500),
    );
    if (url.searchParams.get('format') === 'csv') {
      return new Response(toCsv(rows), {
        headers: {
          'content-type': 'text/csv; charset=utf-8',
          'content-disposition':
            'attachment; filename="leak-stronghold-runs.csv"',
        },
      });
    }
    return Response.json({ rows });
  } catch (error) {
    console.error('research/stronghold GET error:', error);
    return Response.json({ error: 'internal' }, { status: 500 });
  }
}

export async function POST(request: Request) {
  if (!(await requireAdmin())) {
    return new Response(null, { status: 204 });
  }
  const body = (await request
    .json()
    .catch(() => null)) as StrongholdRunInput | null;
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
    const id = await insertStrongholdRun(body);
    return Response.json({ id });
  } catch (error) {
    console.error('research/stronghold POST error:', error);
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
    const deleted = await deleteStrongholdRun(id);
    if (!deleted) return Response.json({ error: 'not found' }, { status: 404 });
    return Response.json({ ok: true });
  } catch (error) {
    console.error('research/stronghold DELETE error:', error);
    return Response.json({ error: 'internal' }, { status: 500 });
  }
}
