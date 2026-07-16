import type { ProblemJob } from '@/lib/db/schema';

// The public shape of a job returned by the /v1 API. Deliberately omits
// internal fields (leasedBy, lease/heartbeat timestamps, raw token counts,
// attempts) — customers only see status, their result, and what they're billed.
export interface PublicJobView {
  id: string;
  status: ProblemJob['status'];
  mock: boolean;
  pricingClass: string | null;
  quotedCredits: number | null;
  chargedCredits: number | null;
  proof: string | null;
  error: string | null;
  createdAt: string;
  finishedAt: string | null;
}

export function publicJobView(job: ProblemJob): PublicJobView {
  return {
    id: job.id,
    status: job.status,
    mock: job.isMock,
    pricingClass: job.pricingClass,
    quotedCredits: job.quotedCredits,
    chargedCredits: job.chargedCredits,
    // Only surface a proof once proved; only surface an error once failed.
    proof: job.status === 'proved' ? job.proof : null,
    error: job.status === 'failed' ? job.resultError : null,
    createdAt: job.createdAt.toISOString(),
    finishedAt: job.finishedAt ? job.finishedAt.toISOString() : null,
  };
}
