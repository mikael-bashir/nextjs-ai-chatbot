import type { NextRequest } from 'next/server';
import { auth } from '@/app/(auth)/auth';
import { isAdminEmail } from '@/lib/admin';
import { pushProblem, queueLength } from '@/lib/redis';

// Admin-only. POST a verified problem onto the Redis queue; GET the queue length.
async function requireAdmin() {
  const session = await auth();
  return isAdminEmail(session?.user?.email) ? session : null;
}

export async function GET() {
  if (!(await requireAdmin()))
    return new Response('Forbidden', { status: 403 });
  try {
    return Response.json({ queued: await queueLength() });
  } catch (error) {
    console.error('Error reading problem queue:', error);
    return new Response('Internal Server Error', { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  if (!(await requireAdmin()))
    return new Response('Forbidden', { status: 403 });
  try {
    const body = await request.json().catch(() => null);
    if (!body || typeof body !== 'object' || !body.lean || !body.proof) {
      return new Response('problem must include at least { lean, proof }', {
        status: 400,
      });
    }
    const record = {
      problem: body.problem ?? null,
      answer: body.answer ?? null,
      insight: body.insight ?? null,
      lean: body.lean,
      proof: body.proof,
      toolchain: body.toolchain ?? 'leanprover/lean4:v4.29.1',
      createdAt: new Date().toISOString(),
    };
    const queued = await pushProblem(record);
    return Response.json({ ok: true, queued });
  } catch (error) {
    console.error('Error pushing problem to queue:', error);
    return new Response('Internal Server Error', { status: 500 });
  }
}
