import { auth } from '@/app/(auth)/auth';
import { isAdminEmail } from '@/lib/admin';
import { createRun, listRuns } from '@/lib/db/benchmark-queries';
import { BENCHMARKS, DEFAULT_BENCHMARK, benchmarkById } from '@/lib/benchmarks';

// Admin capability-benchmarking runs (miniF2F-test, FATE-X).
//   GET  → the benchmark catalogue + runs with live progress/cost aggregates
//   POST { label, benchmark?, model?, strategy?, decompose?, limit?,
//          computeBudgetMs?, maxIters? } → create + seed a run
async function requireAdmin() {
  const session = await auth();
  return isAdminEmail(session?.user?.email) ? session : null;
}

export async function GET() {
  if (!(await requireAdmin())) {
    return Response.json({ error: 'forbidden' }, { status: 403 });
  }
  try {
    return Response.json({
      runs: await listRuns(),
      // The catalogue travels with the list so the client never hard-codes a
      // benchmark id or a problem count that could drift from the server's copy.
      benchmarks: BENCHMARKS.map((b) => ({
        id: b.id,
        label: b.label,
        blurb: b.blurb,
        note: b.note,
        total: b.problems.length,
        sampleSizes: b.sampleSizes,
      })),
    });
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
  const benchmark = benchmarkById(
    typeof body?.benchmark === 'string' ? body.benchmark : DEFAULT_BENCHMARK,
  );
  if (!benchmark) {
    return Response.json({ error: 'unknown benchmark' }, { status: 400 });
  }
  const limit = Number(body?.limit);
  const problems =
    Number.isFinite(limit) && limit > 0
      ? benchmark.problems.slice(0, limit)
      : benchmark.problems;
  const num = (v: unknown) => (Number.isFinite(Number(v)) ? Number(v) : null);
  try {
    const run = await createRun({
      benchmark: benchmark.id,
      label,
      model: typeof body?.model === 'string' ? body.model : null,
      strategy: typeof body?.strategy === 'string' ? body.strategy : null,
      decompose: !!body?.decompose,
      // Recorded so a finished run still says what budget produced it, even
      // after the client-side defaults change.
      computeBudgetMs: num(body?.computeBudgetMs),
      maxIters: num(body?.maxIters),
      problems,
    });
    return Response.json({ run });
  } catch (error) {
    console.error('benchmark POST error:', error);
    return Response.json({ error: 'internal' }, { status: 500 });
  }
}
