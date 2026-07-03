import type { NextRequest } from 'next/server';
import { auth } from '@/app/(auth)/auth';
import { isAdminEmail } from '@/lib/admin';
import {
  deleteProblem,
  listProblems,
  pushProblem,
  queueLength,
  redisHealth,
} from '@/lib/redis';

// Admin-only queue management. GET returns health + the staged items; POST
// enqueues a verified problem; DELETE removes one by id.
async function requireAdmin() {
  const session = await auth();
  return isAdminEmail(session?.user?.email) ? session : null;
}

export async function GET() {
  if (!(await requireAdmin())) {
    return new Response('Forbidden', { status: 403 });
  }
  const health = await redisHealth();
  let items: Awaited<ReturnType<typeof listProblems>> = [];
  if (health.staging.ok) {
    try {
      items = await listProblems();
    } catch (error) {
      console.error('Error listing staged problems:', error);
    }
  }
  return Response.json({
    health,
    // Back-compat: the loop reads `queued` after enqueueing.
    queued: health.staging.length ?? items.length,
    items,
  });
}

export async function POST(request: NextRequest) {
  if (!(await requireAdmin())) {
    return new Response('Forbidden', { status: 403 });
  }
  try {
    const body = await request.json().catch(() => null);
    // `lean` is required; `proof` is optional so a problem can be staged
    // manually (the admin decides), even if it hasn't been re-verified here.
    if (!body || typeof body !== 'object' || !body.lean) {
      return new Response('problem must include at least { lean }', {
        status: 400,
      });
    }
    const record = {
      questionTitle: body.questionTitle ?? null,
      subtitle: body.subtitle ?? null,
      problem: body.problem ?? null,
      answer: body.answer ?? null,
      difficulty: body.difficulty ?? null,
      points: body.points ?? null,
      insight: body.insight ?? null,
      lean: body.lean,
      proof: body.proof ?? '',
      toolchain: body.toolchain ?? 'leanprover/lean4:v4.29.1',
      createdAt: new Date().toISOString(),
    };
    const staged = await pushProblem(record);
    const queued = await queueLength();
    return Response.json({ ok: true, staged, queued });
  } catch (error) {
    console.error('Error pushing problem to queue:', error);
    return new Response('Internal Server Error', { status: 500 });
  }
}

export async function DELETE(request: NextRequest) {
  if (!(await requireAdmin())) {
    return new Response('Forbidden', { status: 403 });
  }
  try {
    const id = new URL(request.url).searchParams.get('id');
    if (!id) {
      return new Response('id query param required', { status: 400 });
    }
    const removed = await deleteProblem(id);
    if (!removed) {
      return new Response('Not found', { status: 404 });
    }
    return Response.json({ ok: true });
  } catch (error) {
    console.error('Error deleting problem from queue:', error);
    return new Response('Internal Server Error', { status: 500 });
  }
}
