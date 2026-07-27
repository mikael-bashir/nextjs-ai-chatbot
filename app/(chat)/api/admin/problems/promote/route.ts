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

    // Every distinct-toolchain certificate this problem accumulated BEFORE
    // ever being promoted (see certsOrFallback client-side) — could be one,
    // could be several if the admin verified it on more than one toolchain
    // pre-publish. Falls back to a single entry from the flat fields for a
    // staged record that predates `certs` or somehow arrived without one.
    type Cert = {
      toolchain: string; mathlib?: string | null; enforcer?: string | null;
      proof: string; verifiedAt?: string | null; signature?: string | null;
      signatureKeyId?: string | null; certMintedAt?: string | null;
    };
    const certList: Cert[] = (rec as { certs?: Cert[] }).certs?.length
      ? (rec as { certs: Cert[] }).certs
      : rec.proof
        ? [{
            toolchain: rec.toolchain ?? 'leanprover/lean4:v4.29.1',
            mathlib: (rec as { mathlib?: string | null }).mathlib ?? null,
            enforcer: (rec as { enforcer?: string | null }).enforcer ?? null,
            proof: rec.proof,
            verifiedAt: (rec as { verifiedAt?: string | null }).verifiedAt ?? null,
            signature: (rec as { signature?: string | null }).signature ?? null,
            signatureKeyId: (rec as { signatureKeyId?: string | null }).signatureKeyId ?? null,
            certMintedAt: (rec as { certMintedAt?: string | null }).certMintedAt ?? null,
          }]
        : [];
    const primary = certList[0];

    // Exactly the fields the weekly-problems cron reads. The flat fields are
    // the PRIMARY (first) certificate, kept for any consumer that only reads
    // a single proof/toolchain; `certificates` carries the FULL list, which
    // is what actually determines how many independent certificates this
    // problem ships with the moment it goes live.
    const prodPayload = {
      questionTitle: rec.questionTitle ?? 'Generated Problem',
      questionProblem: rec.problem ?? '',
      subtitle: rec.subtitle ?? '',
      difficulty: rec.difficulty ?? 'Medium',
      points: rec.points ?? 100,
      answer: rec.answer ?? null,
      knowledge,
      proof: primary?.proof ?? null,
      mintedAt: rec.createdAt ?? null,
      // The real Lean-kernel verification time (set by the verifier) + the
      // certificate signature minted right after it. CompeteMath stores these
      // verbatim (no re-signing), so the published signature is the one made
      // seconds after the kernel verified.
      verifiedAt: primary?.verifiedAt ?? null,
      signature: primary?.signature ?? null,
      signatureKeyId: primary?.signatureKeyId ?? null,
      certMintedAt: primary?.certMintedAt ?? null,
      // Which Lean/Mathlib certified this proof. Sent as a PAIR: the certificate
      // header prints both, and the two verifier groups differ in both.
      toolchain: primary?.toolchain ?? null,
      mathlib: primary?.mathlib ?? null,
      // Which specific strategy enforced this proof, for the certificate's
      // Enforcer line (e.g. "Leak Ultra Fleeting" instead of bland "Leak").
      enforcer: primary?.enforcer ?? null,
      // Every independent certificate this problem has — one row in
      // CompeteMath's question_certificates per entry (see ingestOne).
      certificates: certList,
      // Solver-facing key idea (1-3 sentences). CompeteMath reveals it alongside
      // the answer once a problem is solved or given up.
      insight: rec.insight ?? null,
    };

    // Order matters: publish to prod + persist metadata BEFORE removing from
    // staging, so a failure never loses the problem (it can be retried).
    const prodLength = await pushToProd(prodPayload);
    // Record EVERY toolchain in the leak-side promoted archive (not just the
    // primary one), so promotedToolchainsForTitle correctly reports all of
    // them and a later re-verify on a toolchain already shipped here is
    // recognized as redundant rather than pushed again.
    for (const c of certList) {
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
        proof: c.proof,
        toolchain: c.toolchain,
        promotedAt: new Date(),
      });
    }
    await deleteProblem(id);

    return Response.json({ ok: true, prodLength });
  } catch (error) {
    console.error('Error promoting problem to prod:', error);
    return new Response('Internal Server Error', { status: 500 });
  }
}
