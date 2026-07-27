import { auth } from '@/app/(auth)/auth';
import { isAdminEmail } from '@/lib/admin';
import {
  insertUltraRun,
  listUltraRuns,
  toCsv,
  type UltraRunInput,
} from '@/lib/db/research-queries';

// Leak Ultra (Stone's blueprint pipeline, local Claude CLI driver) telemetry.
//   GET  ?format=csv → CSV export for plotting; otherwise JSON { rows }
//   POST { ...UltraRunInput } → { id }, one row per verification attempt
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
    const rows = await listUltraRuns(
      Math.min(5000, Number(url.searchParams.get('limit')) || 500),
    );
    if (url.searchParams.get('format') === 'csv') {
      return new Response(toCsv(rows), {
        headers: {
          'content-type': 'text/csv; charset=utf-8',
          'content-disposition': 'attachment; filename="leak-ultra-runs.csv"',
        },
      });
    }
    return Response.json({ rows });
  } catch (error) {
    console.error('research/ultra GET error:', error);
    return Response.json({ error: 'internal' }, { status: 500 });
  }
}

export async function POST(request: Request) {
  if (!(await requireAdmin())) {
    return new Response(null, { status: 204 });
  }
  const body = (await request.json().catch(() => null)) as UltraRunInput | null;
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
    const id = await insertUltraRun(body);
    return Response.json({ id });
  } catch (error) {
    console.error('research/ultra POST error:', error);
    return Response.json({ error: 'internal' }, { status: 500 });
  }
}
