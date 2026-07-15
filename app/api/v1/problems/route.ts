import type { NextRequest } from 'next/server';

import { authenticateApiKey } from '@/lib/api-auth';
import {
  enqueueJob,
  resolveMockJob,
  getJobById,
} from '@/lib/db/leak-queries';
import { getOrCreateCreditBalance } from '@/lib/db/queries';
import { MOCK_PROOF } from '@/lib/leak/pricing';
import { publicJobView } from '@/lib/leak/serialize';


const MAX_PROBLEM_CHARS = 20_000;
// Pay-for-compute: no up-front quote, just a floor to start a run. The actual
// bill (1.2× LLM cost) is metered during the run and settled on completion.
const MIN_SUBMIT_CREDITS = 1;

function err(code: string, message: string, status: number) {
  return Response.json({ error: { code, message } }, { status });
}

// POST /api/v1/problems — submit a maths problem for proving.
// Auth: `Authorization: Bearer leak_sk_…`. Body: { problem: string, mock?: bool }.
export async function POST(request: NextRequest) {
  const principal = await authenticateApiKey(request);
  if (!principal) {
    return err('unauthorized', 'Missing or invalid API key.', 401);
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return err('invalid_body', 'Request body must be valid JSON.', 400);
  }

  const problem = (body as { problem?: unknown })?.problem;
  const mock = (body as { mock?: unknown })?.mock === true;

  if (typeof problem !== 'string' || problem.trim().length === 0) {
    return err('invalid_problem', '`problem` must be a non-empty string.', 400);
  }
  if (problem.length > MAX_PROBLEM_CHARS) {
    return err(
      'problem_too_large',
      `\`problem\` exceeds ${MAX_PROBLEM_CHARS} characters.`,
      400,
    );
  }

  // Mock: free, resolves instantly to a canned proof so a new user can test
  // the full submit→poll flow before any real worker capacity exists.
  if (mock) {
    const job = await enqueueJob({
      userId: principal.userId,
      apiKeyId: principal.apiKeyId,
      problem,
      isMock: true,
      pricingClass: 'mock',
      quotedCredits: 0,
    });
    const proved = (await resolveMockJob({ id: job.id, proof: MOCK_PROOF })) ?? job;
    return Response.json(publicJobView(proved), { status: 201 });
  }

  // Real job: pay-for-compute. We don't quote up front — the run is billed at
  // 1.2× its actual LLM cost on completion, and the worker aborts mid-run if the
  // cost would exceed the balance (so a thin balance can't fund a huge search).
  // The only gate here is a minimum balance to start.
  const balance = await getOrCreateCreditBalance({ userId: principal.userId });
  if (balance < MIN_SUBMIT_CREDITS) {
    return err(
      'insufficient_credits',
      `A minimum balance of ${MIN_SUBMIT_CREDITS} credit is required to submit; your balance is ${balance}. Top up to continue.`,
      402,
    );
  }

  const job = await enqueueJob({
    userId: principal.userId,
    apiKeyId: principal.apiKeyId,
    problem,
    isMock: false,
    pricingClass: 'metered', // billed at 1.2× actual cost, not a fixed quote
    quotedCredits: null,
  });

  // Re-read to return a consistent serialized view.
  const fresh = (await getJobById({ id: job.id })) ?? job;
  return Response.json(publicJobView(fresh), { status: 202 });
}
