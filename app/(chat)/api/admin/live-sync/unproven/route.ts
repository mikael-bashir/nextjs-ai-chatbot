import { auth } from '@/app/(auth)/auth';
import { isAdminEmail } from '@/lib/admin';

// Proxies CompeteMath's admin-only unproven-live-problems list — server-side
// only, so LEAK_SYNC_SECRET never reaches the browser. Same COMPETEMATH_BASE_URL
// convention as live-problems/route.ts.
const COMPETEMATH_BASE = (
  process.env.COMPETEMATH_BASE_URL || 'https://www.competemath.com'
).replace(/\/$/, '');

export async function GET() {
  const session = await auth();
  if (!isAdminEmail(session?.user?.email)) {
    return Response.json({ error: 'forbidden' }, { status: 403 });
  }
  const secret = process.env.LEAK_SYNC_SECRET;
  if (!secret) {
    return Response.json({ error: 'LEAK_SYNC_SECRET not configured' }, { status: 500 });
  }
  try {
    const r = await fetch(`${COMPETEMATH_BASE}/api/admin/problems/unproven`, {
      headers: { Authorization: `Bearer ${secret}` },
      cache: 'no-store',
    });
    if (!r.ok) {
      return Response.json({ error: `CompeteMath returned ${r.status}` }, { status: 502 });
    }
    const data = await r.json();
    return Response.json(data);
  } catch (error) {
    console.error('live-sync unproven fetch error:', error);
    return Response.json({ error: 'Could not reach CompeteMath' }, { status: 502 });
  }
}
