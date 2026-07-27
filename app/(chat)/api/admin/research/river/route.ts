import { auth } from '@/app/(auth)/auth';
import { isAdminEmail } from '@/lib/admin';
import {
  insertRiverRun,
  listRiverRuns,
  toCsv,
  type RiverRunInput,
} from '@/lib/db/research-queries';

// Leak River (Goedel-Architect-style blueprint pipeline) research telemetry.
//   GET  ?format=csv → CSV export for plotting; otherwise JSON { rows }
//   POST { ...RiverRunInput } → { id }, one row per verification attempt
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
