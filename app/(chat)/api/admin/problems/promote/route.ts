import type { NextRequest } from 'next/server';
import { auth } from '@/app/(auth)/auth';
import { isAdminEmail } from '@/lib/admin';
import {
  deleteProblem,
  listProblems,
  prodHasTitle,
  pushToProd,
} from '@/lib/redis';
import {
  hasPromotedTitle,
  saveGeneratedProblem,
} from '@/lib/db/generated-problem-queries';

// Promote a staged problem to the production CompeteMath queue. The main app's
// weekly-problems cron LPOPs `weekly-problems` and inserts exactly these fields
// into its `questions` table — so the payload must match that shape precisely.
// Lean/proof and other internal metadata are NOT part of the prod payload; they
// are persisted to the GeneratedProblem table instead.
async function requireAdmin() {
  const session = await auth();
  return isAdminEmail(session?.user?.email) ? session : null;
}

export async function POST(request: NextRequest) {
  if (!(await requireAdmin())) {
    return new Response('Forbidden', { status: 403 });
  }
  try {
    const body = await request.json().catch(() => null);
    const id = body?.id;
    if (!id || typeof id !== 'string') {
      return new Response('id required', { status: 400 });
    }

    const rec = (await listProblems()).find((p) => p.id === id);
    if (!rec) {
      return new Response('Not found', { status: 404 });
    }

    // Robustness guard: never double-publish. Check BOTH the transient prod
    // queue (still awaiting the cron) AND the durable GeneratedProblem archive
    // (already promoted, possibly already drained to live) — so a problem can't
    // be re-promoted after the cron empties the queue.
    if (
      (await prodHasTitle(rec.questionTitle)) ||
      (await hasPromotedTitle(rec.questionTitle))
    ) {
      return new Response(
        'A problem with this title has already been promoted to prod.',
        { status: 409 },
      );
    }

    // Prerequisite-knowledge level (1-5) → CompeteMath's `knowledge` column as
    // "Level N"; omitted (null) if the model didn't assign a valid level.
    const lvl = Number(rec.level);
    const knowledge =
      Number.isInteger(lvl) && lvl >= 1 && lvl <= 5 ? `Level ${lvl}` : null;

    // Exactly the fields the weekly-problems cron reads. Includes the Lean proof
    // + provenance so CompeteMath can render a verification CERTIFICATE for the
    // problem: `proof` is the machine-checked script, `mintedAt` is when it was
    // generated, `toolchain` is the Lean/Mathlib it was enforced against.
    const prodPayload = {
      questionTitle: rec.questionTitle ?? 'Generated Problem',
      questionProblem: rec.problem ?? '',
      subtitle: rec.subtitle ?? '',
      difficulty: rec.difficulty ?? 'Medium',
      points: rec.points ?? 100,
      answer: rec.answer ?? null,
      knowledge,
      proof: rec.proof ?? null,
      mintedAt: rec.createdAt ?? null,
      // The real Lean-kernel verification time (set by the verifier), so the
      // certificate's "Enforced/verified" timestamp is authentic — independent
      // of when CompeteMath mints (signs) it at ingestion.
      verifiedAt: (rec as { verifiedAt?: string | null }).verifiedAt ?? null,
      toolchain: rec.toolchain ?? null,
      // Solver-facing key idea (1-3 sentences). CompeteMath reveals it alongside
      // the answer once a problem is solved or given up.
      insight: rec.insight ?? null,
    };

    // Order matters: publish to prod + persist metadata BEFORE removing from
    // staging, so a failure never loses the problem (it can be retried).
    const prodLength = await pushToProd(prodPayload);
    await saveGeneratedProblem({
      problemId: rec.id,
      questionTitle: rec.questionTitle ?? null,
      subtitle: rec.subtitle ?? null,
      problem: rec.problem ?? null,
      answer: rec.answer ?? null,
      difficulty: rec.difficulty ?? null,
      points: rec.points ?? null,
      insight: rec.insight ?? null,
      lean: rec.lean,
      proof: rec.proof,
      toolchain: rec.toolchain ?? null,
      promotedAt: new Date(),
    });
    await deleteProblem(id);

    return Response.json({ ok: true, prodLength });
  } catch (error) {
    console.error('Error promoting problem to prod:', error);
    return new Response('Internal Server Error', { status: 500 });
  }
}
