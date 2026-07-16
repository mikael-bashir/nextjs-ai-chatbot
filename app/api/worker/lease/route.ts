import type { NextRequest } from 'next/server';

import { authenticateWorker } from '@/lib/leak/worker-auth';
import { leaseNextJob } from '@/lib/db/leak-queries';
import { getProverMcpServers } from '@/lib/leak/prover-servers';
import { getOrCreateCreditBalance } from '@/lib/db/queries';
import { getUsdToGbpRate } from '@/lib/pricing';

const COST_MARKUP = 1.2; // keep in sync with /api/worker/complete


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
  // 'operator' worker (the admin's own bridge) drains only delegated jobs;
  // anything else is the autonomous hosted worker, which skips delegated jobs.
  const kind = body?.kind === 'operator' ? 'operator' : 'hosted';

  const job = await leaseNextJob({ workerId, leaseMs, kind });
  if (!job) return Response.json({ job: null });

  // Hand the worker the hard-set Leak prover MCP servers so its direct
  // claude+MCP run drives the real Leak_I/Leak_II tools — the same servers the
  // interactive /prove flow uses. Non-fatal if unavailable (worker falls back
  // to its own WORKER_MCP_CONFIG).
  const mcpServers = await getProverMcpServers().catch(() => []);

  // The mid-run spend ceiling. The customer is billed COST_MARKUP × cost_usd (in
  // £ credits), so the run must abort once cost_usd would exhaust the balance:
  //   maxCostUsd = balance / (markup × usd→gbp).
  // Mock jobs (or a missing rate) → no ceiling (Infinity) — nothing to bill.
  const balanceCredits = await getOrCreateCreditBalance({
    userId: job.userId,
  }).catch(() => 0);
  const rate = (await getUsdToGbpRate().catch(() => 0)) || 0;
  const maxCostUsd =
    rate > 0 ? balanceCredits / (COST_MARKUP * rate) : Number.POSITIVE_INFINITY;

  // Worker-facing view: problem text, identifiers, prover servers, and the hard
  // cost ceiling for this run.
  return Response.json({
    job: {
      id: job.id,
      problem: job.problem,
      pricingClass: job.pricingClass,
      attempts: job.attempts,
      leaseExpiresAt: job.leaseExpiresAt,
      mcpServers,
      maxCostUsd,
    },
  });
}
