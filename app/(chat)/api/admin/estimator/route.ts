import { auth } from '@/app/(auth)/auth';
import { isAdminEmail } from '@/lib/admin';

// Server proxy to the self-hosted cost-estimator service (internal Docker
// network, not publicly reachable). The admin UI calls THIS; we forward to the
// estimator's /predict and /stats. Admin-gated. Returns { available: false }
// (never an error) when the estimator isn't configured or is down, so the client
// falls back to the k-NN estimate cleanly.
const ESTIMATOR_URL = (process.env.ESTIMATOR_URL || '').replace(/\/$/, '');

async function requireAdmin() {
  const session = await auth();
  return isAdminEmail(session?.user?.email);
}

export async function POST(request: Request) {
  if (!(await requireAdmin())) {
    return Response.json({ error: 'forbidden' }, { status: 403 });
  }
  if (!ESTIMATOR_URL) return Response.json({ available: false });
  try {
    const body = await request.json().catch(() => ({}));
    const res = await fetch(`${ESTIMATOR_URL}/predict`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        signature: body?.signature ?? '',
        budgetUsd: body?.budgetUsd,
        minProveProb: body?.minProveProb,
      }),
      signal: AbortSignal.timeout(4000),
    });
    if (!res.ok) return Response.json({ available: false });
    return Response.json({ available: true, ...(await res.json()) });
  } catch {
    return Response.json({ available: false });
  }
}

export async function GET() {
  if (!(await requireAdmin())) {
    return Response.json({ error: 'forbidden' }, { status: 403 });
  }
  if (!ESTIMATOR_URL) return Response.json({ available: false });
  try {
    const res = await fetch(`${ESTIMATOR_URL}/stats`, {
      signal: AbortSignal.timeout(4000),
    });
    if (!res.ok) return Response.json({ available: false });
    return Response.json({ available: true, ...(await res.json()) });
  } catch {
    return Response.json({ available: false });
  }
}
