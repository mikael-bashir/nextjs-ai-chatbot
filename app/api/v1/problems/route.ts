import type { NextRequest } from 'next/server';

import { authenticateApiKey } from '@/lib/api-auth';
import {
  enqueueJob,
  resolveMockJob,
  getJobById,
} from '@/lib/db/leak-queries';
import { getOrCreateCreditBalance } from '@/lib/db/queries';
import { quoteProblem, MOCK_PROOF } from '@/lib/leak/pricing';
import { publicJobView } from '@/lib/leak/serialize';


const MAX_PROBLEM_CHARS = 20_000;

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

  // Real job: quote it and make sure the account can cover the quote before we
  // accept work. Capture happens on success; a failed proof is never charged.
  const quote = quoteProblem(problem);
  const balance = await getOrCreateCreditBalance({ userId: principal.userId });
  if (balance < quote.quotedCredits) {
    return err(
      'insufficient_credits',
      `This problem is quoted at ${quote.quotedCredits} credits but your balance is ${balance}. Top up to submit.`,
      402,
    );
  }

  const job = await enqueueJob({
    userId: principal.userId,
    apiKeyId: principal.apiKeyId,
    problem,
    isMock: false,
    pricingClass: quote.pricingClass,
    quotedCredits: quote.quotedCredits,
  });

  // Re-read to return a consistent serialized view.
  const fresh = (await getJobById({ id: job.id })) ?? job;
  return Response.json(publicJobView(fresh), { status: 202 });
}
