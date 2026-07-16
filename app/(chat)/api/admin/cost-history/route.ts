import { auth } from '@/app/(auth)/auth';
import { isAdminEmail } from '@/lib/admin';
import {
  insertEstimate,
  recordActual,
  nearestNeighbors,
  accuracyStats,
  globalCostStats,
  type CostFeatures,
  type EstimateInput,
} from '@/lib/db/cost-history-queries';

// Admin-only cost-estimator memory. Not part of the customer /v1 API.
//   GET  ?stats            → estimator scoreboard (N / MAPE / bias, per-difficulty)
//   GET  ?neighbors&<feat> → K nearest past problems with their actual costs
//   POST { ...features, estimateUsd, estimateLow, estimateHigh, rationale } → { id }
//   PATCH { id, actualUsd, verified } → records the actual once a proof finishes
async function requireAdmin() {
  const session = await auth();
  return isAdminEmail(session?.user?.email) ? session : null;
}

function featuresFromParams(p: URLSearchParams): CostFeatures {
  const num = (k: string) => {
    const v = p.get(k);
    return v == null || v === '' ? null : Number(v);
  };
  const bool = (k: string) => {
    const v = p.get(k);
    return v == null ? null : v === 'true' || v === '1';
  };
  return {
    title: p.get('title'),
    difficulty: p.get('difficulty'),
    level: num('level'),
    topic: p.get('topic'),
    problemLen: num('problemLen'),
    leanLen: num('leanLen'),
    usesDecide: bool('usesDecide'),
    isGeneral: bool('isGeneral'),
    hypCount: num('hypCount'),
    decompose: bool('decompose'),
    model: p.get('model'),
  };
}

export async function GET(request: Request) {
  if (!(await requireAdmin())) {
    return Response.json({ error: 'forbidden' }, { status: 403 });
  }
  const url = new URL(request.url);
  const p = url.searchParams;
  try {
    if (p.has('stats')) {
      return Response.json({ stats: await accuracyStats() });
    }
    if (p.has('neighbors')) {
      // Adaptive K grows with history (≈3·√n, bounded) so the k-NN quantile
      // regressor stays consistent: more data ⇒ more neighbours ⇒ tighter
      // convergence to the true conditional cost quantile.
      const global = await globalCostStats();
      const kAuto = Math.round(3 * Math.sqrt(Math.max(0, global.n)));
      const k = Math.min(60, Math.max(12, Number(p.get('k')) || kAuto || 12));
      const neighbors = await nearestNeighbors(featuresFromParams(p), k);
      return Response.json({ neighbors, global });
    }
    return Response.json({ error: 'unknown_query' }, { status: 400 });
  } catch (error) {
    console.error('cost-history GET error:', error);
    return Response.json({ error: 'internal' }, { status: 500 });
  }
}

export async function POST(request: Request) {
  if (!(await requireAdmin())) {
    return Response.json({ error: 'forbidden' }, { status: 403 });
  }
  const body = (await request.json().catch(() => null)) as EstimateInput | null;
  if (!body || !Number.isFinite(Number(body.estimateUsd))) {
    return Response.json({ error: 'estimateUsd required' }, { status: 400 });
  }
  try {
    const id = await insertEstimate({
      ...body,
      estimateUsd: Number(body.estimateUsd),
      estimateLow: body.estimateLow == null ? null : Number(body.estimateLow),
      estimateHigh: body.estimateHigh == null ? null : Number(body.estimateHigh),
    });
    return Response.json({ id });
  } catch (error) {
    console.error('cost-history POST error:', error);
    return Response.json({ error: 'internal' }, { status: 500 });
  }
}

export async function PATCH(request: Request) {
  if (!(await requireAdmin())) {
    return Response.json({ error: 'forbidden' }, { status: 403 });
  }
  const body = await request.json().catch(() => null);
  const id = body?.id;
  const actualUsd = Number(body?.actualUsd);
  if (typeof id !== 'string' || !Number.isFinite(actualUsd)) {
    return Response.json({ error: 'id + actualUsd required' }, { status: 400 });
  }
  try {
    await recordActual(id, actualUsd, !!body?.verified);
    return Response.json({ ok: true });
  } catch (error) {
    console.error('cost-history PATCH error:', error);
    return Response.json({ error: 'internal' }, { status: 500 });
  }
}
