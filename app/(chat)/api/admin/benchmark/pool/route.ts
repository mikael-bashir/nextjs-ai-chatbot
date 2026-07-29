import { auth } from '@/app/(auth)/auth';
import { isAdminEmail } from '@/lib/admin';
import { benchmarkById } from '@/lib/benchmarks';

async function requireAdmin() {
  const session = await auth();
  return isAdminEmail(session?.user?.email) ? session : null;
}

// GET ?benchmark=<id> → the full problem pool for one benchmark, straight from
// the server's own bundled dataset (never the client). Fetched lazily by the
// picker — the main catalogue route stays light since it's loaded on every
// page visit, while a pool (up to 244 statements) is only pulled when the
// picker is actually opened.
export async function GET(request: Request) {
  if (!(await requireAdmin())) {
    return Response.json({ error: 'forbidden' }, { status: 403 });
  }
  const id = new URL(request.url).searchParams.get('benchmark');
  const benchmark = benchmarkById(id);
  if (!benchmark) {
    return Response.json({ error: 'unknown benchmark' }, { status: 400 });
  }
  return Response.json({ problems: benchmark.problems });
}
