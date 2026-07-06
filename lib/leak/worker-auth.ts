import 'server-only';

import { createHash, timingSafeEqual } from 'node:crypto';

// The operator's worker(s) authenticate to the deployment-queue data-plane with
// a single shared secret (env `LEAK_WORKER_SECRET`), sent as `x-worker-secret`.
// Fail-closed: if the secret isn't configured, no worker is ever authorised.
export function authenticateWorker(request: Request): boolean {
  const configured = process.env.LEAK_WORKER_SECRET;
  if (!configured) return false;

  const provided = request.headers.get('x-worker-secret');
  if (!provided) return false;

  // Constant-time compare over fixed-length digests to avoid length/timing leaks.
  const a = createHash('sha256').update(provided).digest();
  const b = createHash('sha256').update(configured).digest();
  return timingSafeEqual(a, b);
}
