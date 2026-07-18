import { auth } from '@/app/(auth)/auth';
import { isAdminEmail } from '@/lib/admin';

const COMPETEMATH_BASE = (
  process.env.COMPETEMATH_BASE_URL || 'https://www.competemath.com'
).replace(/\/$/, '');

// Proxies CompeteMath's attach-proof endpoint — the last step of "push prove":
// takes a proof for a problem that's already live, signs+attaches it to that
// existing row. Body is passed through verbatim (title, proof, provedAt,
// signature, signatureKeyId, certMintedAt — see the push-prove console).
export async function POST(request: Request) {
  const session = await auth();
  if (!isAdminEmail(session?.user?.email)) {
    return Response.json({ error: 'forbidden' }, { status: 403 });
  }
  const secret = process.env.LEAK_SYNC_SECRET;
  if (!secret) {
    return Response.json({ error: 'LEAK_SYNC_SECRET not configured' }, { status: 500 });
  }
  const body = await request.text();
  try {
    const r = await fetch(`${COMPETEMATH_BASE}/api/admin/problems/attach-proof`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${secret}`,
        'content-type': 'application/json',
      },
      body,
    });
    const data = await r.json().catch(() => ({}));
    return Response.json(data, { status: r.status });
  } catch (error) {
    console.error('live-sync attach-proof error:', error);
    return Response.json({ error: 'Could not reach CompeteMath' }, { status: 502 });
  }
}
