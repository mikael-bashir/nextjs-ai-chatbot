import type { NextRequest } from 'next/server';
import { auth } from '@/app/(auth)/auth';
import { isAdminEmail } from '@/lib/admin';
import {
  deleteProblem,
  listProblems,
  listProdProblems,
  pushProblem,
  queueLength,
  redisHealth,
  stagingHasTitle,
} from '@/lib/redis';
import {
  hasPromotedTitle,
  promotedTitles,
} from '@/lib/db/generated-problem-queries';

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
  // Titles that have been promoted to prod, so the pipeline can flag them. Union
  // of (a) the transient `weekly-problems` queue — items still AWAITING the
  // CompeteMath cron, and (b) the DURABLE GeneratedProblem archive — everything
  // ever promoted. (b) is what keeps the prod badge from vanishing once the cron
  // drains the queue. Best-effort: each source is optional.
  const prodTitleSet = new Set<string>();
  if (health.prod.ok) {
    try {
      for (const p of await listProdProblems()) {
        if (p.questionTitle) prodTitleSet.add(p.questionTitle);
      }
    } catch (error) {
      console.error('Error listing prod problems:', error);
    }
  }
  try {
    for (const t of await promotedTitles()) prodTitleSet.add(t);
  } catch (error) {
    console.error('Error listing promoted problems:', error);
  }
  const prodItems = Array.from(prodTitleSet);
  return Response.json({
    health,
    // Back-compat: the loop reads `queued` after enqueueing.
    queued: health.staging.length ?? items.length,
    items,
    prodItems,
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
    // Robustness guard: never double-stage the same problem. If one with this
    // title is already in staging, refuse (409) instead of pushing a duplicate.
    if (await stagingHasTitle(body.questionTitle)) {
      return Response.json(
        {
          ok: false,
          duplicate: true,
          error: 'A problem with this title is already in staging.',
        },
        { status: 409 },
      );
    }
    // Also refuse re-staging something already PROMOTED to prod. This checks the
    // durable GeneratedProblem archive, not the transient prod queue — so it
    // still fires after the CompeteMath cron has drained the queue (the bug this
    // fixes: a promoted problem could be re-staged once the queue emptied).
    if (await hasPromotedTitle(body.questionTitle)) {
      return Response.json(
        {
          ok: false,
          duplicate: true,
          error: 'A problem with this title was already promoted to prod.',
        },
        { status: 409 },
      );
    }
    const record = {
      questionTitle: body.questionTitle ?? null,
      subtitle: body.subtitle ?? null,
      problem: body.problem ?? null,
      answer: body.answer ?? null,
      difficulty: body.difficulty ?? null,
      points: body.points ?? null,
      level: body.level ?? null,
      insight: body.insight ?? null,
      lean: body.lean,
      proof: body.proof ?? '',
      toolchain: body.toolchain ?? 'leanprover/lean4:v4.29.1',
      verifiedAt: body.verifiedAt ?? null,
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
