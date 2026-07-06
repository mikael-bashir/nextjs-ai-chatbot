import type { NextRequest } from 'next/server';

import { authenticateApiKey } from '@/lib/api-auth';
import { getJobById } from '@/lib/db/leak-queries';
import { publicJobView } from '@/lib/leak/serialize';


function err(code: string, message: string, status: number) {
  return Response.json({ error: { code, message } }, { status });
}

// GET /api/v1/problems/:id — poll a submitted job's status/result.
// Scoped to the API key's owner so one account can't read another's jobs.
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const principal = await authenticateApiKey(request);
  if (!principal) {
    return err('unauthorized', 'Missing or invalid API key.', 401);
  }

  const { id } = await params;
  const job = await getJobById({ id, userId: principal.userId });
  if (!job) {
    return err('not_found', 'No such problem for this account.', 404);
  }

  return Response.json(publicJobView(job));
}
