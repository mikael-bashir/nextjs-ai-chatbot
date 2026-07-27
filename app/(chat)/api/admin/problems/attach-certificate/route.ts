import type { NextRequest } from 'next/server';
import { auth } from '@/app/(auth)/auth';
import { isAdminEmail } from '@/lib/admin';
import { pushToProd } from '@/lib/redis';
import {
  hasPromotedTitle,
  promotedToolchainsForTitle,
  saveGeneratedProblem,
} from '@/lib/db/generated-problem-queries';

// Backend-only robustness feature: when an ALREADY-PUBLISHED problem gets
// re-verified (e.g. re-run on a different MCP server group) and the new run
// succeeds on a toolchain that problem doesn't have a certificate for yet,
// push the new certificate straight to prod — no staging, no manual promote
// click. If the title was never published, or this toolchain is already
// covered, this is a no-op. No UI changes: this is called automatically from
// the verify-completion handler after every successful verify+sign.
//
// CompeteMath's ingestion cron matches incoming payloads by questionTitle: an
// existing title gets this proof ATTACHED as an additional certificate
// (question_certificates, one per toolchain) rather than creating a second
// `questions` row. See weekly-problems-injection.
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
    const questionTitle = typeof body?.questionTitle === 'string' ? body.questionTitle : null;
    const toolchain = typeof body?.toolchain === 'string' ? body.toolchain : null;
    const proof = typeof body?.proof === 'string' ? body.proof : null;
    const lean = typeof body?.lean === 'string' ? body.lean : null;
    if (!questionTitle || !toolchain || !proof || !lean) {
      return Response.json(
        { ok: false, error: 'questionTitle, toolchain, proof and lean are required' },
        { status: 400 },
      );
    }

    if (!(await hasPromotedTitle(questionTitle))) {
      // Never published before — this is a brand-new problem, not a second
      // certificate for an existing one. Leave it to the normal manual
      // staging → promote flow.
      return Response.json({ ok: true, skipped: 'not-yet-published' });
    }
    const covered = await promotedToolchainsForTitle(questionTitle);
    if (covered.includes(toolchain)) {
      // This exact toolchain already has a certificate for this problem —
      // a redundant re-proof, not a new one. Nothing to do.
      return Response.json({ ok: true, skipped: 'toolchain-already-covered' });
    }

    const lvl = Number(body?.level);
    const knowledge =
      Number.isInteger(lvl) && lvl >= 1 && lvl <= 5 ? `Level ${lvl}` : null;

    const prodPayload = {
      questionTitle,
      questionProblem: body?.problem ?? '',
      subtitle: body?.subtitle ?? '',
      difficulty: body?.difficulty ?? 'Medium',
      points: body?.points ?? 100,
      answer: body?.answer ?? null,
      knowledge,
      proof,
      mintedAt: body?.createdAt ?? null,
      verifiedAt: body?.verifiedAt ?? null,
      signature: body?.signature ?? null,
      signatureKeyId: body?.signatureKeyId ?? null,
      certMintedAt: body?.certMintedAt ?? null,
      toolchain,
      mathlib: body?.mathlib ?? null,
      enforcer: body?.enforcer ?? null,
      insight: body?.insight ?? null,
    };

    const prodLength = await pushToProd(prodPayload);
    await saveGeneratedProblem({
      problemId: typeof body?.id === 'string' ? body.id : null,
      questionTitle,
      subtitle: body?.subtitle ?? null,
      problem: body?.problem ?? null,
      answer: body?.answer ?? null,
      difficulty: body?.difficulty ?? null,
      points: body?.points ?? null,
      insight: body?.insight ?? null,
      lean,
      proof,
      toolchain,
      promotedAt: new Date(),
    });

    return Response.json({ ok: true, pushed: true, prodLength });
  } catch (error) {
    console.error('Error attaching certificate to prod problem:', error);
    return Response.json({ ok: false, error: 'Internal Server Error' }, { status: 500 });
  }
}
