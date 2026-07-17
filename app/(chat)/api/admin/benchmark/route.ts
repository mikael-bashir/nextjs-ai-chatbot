import { auth } from '@/app/(auth)/auth';
import { isAdminEmail } from '@/lib/admin';
import { createRun, listRuns } from '@/lib/db/benchmark-queries';
import { MINIF2F_TEST } from '@/lib/benchmarks/minif2f';

// Admin capability-benchmarking runs (miniF2F-test today).
//   GET  → list runs with live progress/cost aggregates
//   POST { label, model?, strategy?, decompose?, limit? } → create + seed a run
async function requireAdmin() {
  const session = await auth();
  return isAdminEmail(session?.user?.email) ? session : null;
}

export async function GET() {
  if (!(await requireAdmin())) {
    return Response.json({ error: 'forbidden' }, { status: 403 });
  }
  try {
    return Response.json({ runs: await listRuns() });
  } catch (error) {
    console.error('benchmark GET error:', error);
    return Response.json({ error: 'internal' }, { status: 500 });
  }
}

export async function POST(request: Request) {
  if (!(await requireAdmin())) {
    return Response.json({ error: 'forbidden' }, { status: 403 });
  }
  const body = await request.json().catch(() => null);
  const label = typeof body?.label === 'string' ? body.label.trim() : '';
  if (!label) {
    return Response.json({ error: 'label required' }, { status: 400 });
  }
  // The dataset always comes from the server's own bundled copy — never from
  // the client — so a run can't be seeded with tampered statements.
  const limit = Number(body?.limit);
  const problems = (
    Number.isFinite(limit) && limit > 0
      ? MINIF2F_TEST.slice(0, limit)
      : MINIF2F_TEST
  ).map((p) => ({ id: p.id, statement: p.statement, informal: p.informal }));
  try {
    const run = await createRun({
      benchmark: 'minif2f-test',
      label,
      model: typeof body?.model === 'string' ? body.model : null,
      strategy: typeof body?.strategy === 'string' ? body.strategy : null,
      decompose: !!body?.decompose,
      problems,
    });
    return Response.json({ run });
  } catch (error) {
    console.error('benchmark POST error:', error);
    return Response.json({ error: 'internal' }, { status: 500 });
  }
}
