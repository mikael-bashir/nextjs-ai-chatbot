import type { NextRequest } from 'next/server';

import { authenticateWorker } from '@/lib/leak/worker-auth';
import { heartbeatJob } from '@/lib/db/leak-queries';


const DEFAULT_LEASE_MS = 5 * 60_000;

// POST /api/worker/heartbeat  { jobId, workerId, status? }
// Keeps a long-running proof's lease alive and optionally flips it to 'proving'.
export async function POST(request: NextRequest) {
  if (!authenticateWorker(request)) {
    return Response.json({ error: 'unauthorized' }, { status: 401 });
  }

  const body = await request.json().catch(() => ({}));
  const jobId = body?.jobId;
  const workerId = body?.workerId;
  if (typeof jobId !== 'string' || typeof workerId !== 'string') {
    return Response.json(
      { error: 'jobId and workerId required' },
      { status: 400 },
    );
  }

  const status = body?.status === 'proving' ? 'proving' : 'leased';
  const ok = await heartbeatJob({
    id: jobId,
    workerId,
    leaseMs: DEFAULT_LEASE_MS,
    status,
  });

  // Lease lost (expired + reclaimed by another worker): tell the worker to stop.
  if (!ok) return Response.json({ ok: false, lost: true }, { status: 409 });
  return Response.json({ ok: true });
}
