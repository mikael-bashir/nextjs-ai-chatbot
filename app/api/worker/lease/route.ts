import type { NextRequest } from 'next/server';

import { authenticateWorker } from '@/lib/leak/worker-auth';
import { leaseNextJob } from '@/lib/db/leak-queries';
import { getProverMcpServers } from '@/lib/leak/prover-servers';


// Default lease window. The worker must heartbeat within this or the job is
// considered abandoned and re-queued for another worker.
const DEFAULT_LEASE_MS = 5 * 60_000;

// POST /api/worker/lease  { workerId, leaseMs? }
// Auth: x-worker-secret. Atomically claims the oldest queued (or lease-expired)
// job. Returns { job } or { job: null } when the queue is empty.
export async function POST(request: NextRequest) {
  if (!authenticateWorker(request)) {
    return Response.json({ error: 'unauthorized' }, { status: 401 });
  }

  const body = await request.json().catch(() => ({}));
  const workerId =
    typeof body?.workerId === 'string' && body.workerId.trim()
      ? body.workerId.trim().slice(0, 128)
      : 'worker';
  const leaseMs =
    typeof body?.leaseMs === 'number' && body.leaseMs > 0
      ? Math.min(body.leaseMs, 30 * 60_000)
      : DEFAULT_LEASE_MS;

  const job = await leaseNextJob({ workerId, leaseMs });
  if (!job) return Response.json({ job: null });

  // Hand the worker the hard-set Leak prover MCP servers so its direct
  // claude+MCP run drives the real Leak_I/Leak_II tools — the same servers the
  // interactive /prove flow uses. Non-fatal if unavailable (worker falls back
  // to its own WORKER_MCP_CONFIG).
  const mcpServers = await getProverMcpServers().catch(() => []);

  // Worker-facing view: problem text, identifiers, and the prover servers.
  return Response.json({
    job: {
      id: job.id,
      problem: job.problem,
      pricingClass: job.pricingClass,
      attempts: job.attempts,
      leaseExpiresAt: job.leaseExpiresAt,
      mcpServers,
    },
  });
}
