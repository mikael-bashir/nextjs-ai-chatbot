import type { NextRequest } from 'next/server';
import { auth } from '@/app/(auth)/auth';
import { isAdminEmail } from '@/lib/admin';
import {
  GENERATED_CAP,
  deleteGenerated,
  listGenerated,
  pushProblem,
  saveGenerated,
} from '@/lib/redis';

// The full generation history: every problem Claude produces is stored here,
// verified or not, so nothing is ever silently discarded. Capped at
// GENERATED_CAP server-side. Verified problems are ALSO pushed to the staging
// review queue for promotion to prod.
async function requireAdmin() {
  const session = await auth();
  return isAdminEmail(session?.user?.email) ? session : null;
}

export async function GET() {
  if (!(await requireAdmin())) {
    return new Response('Forbidden', { status: 403 });
  }
  try {
    const items = await listGenerated();
    return Response.json({ items, count: items.length, cap: GENERATED_CAP });
  } catch (error) {
    console.error('Error listing generated problems:', error);
    return new Response('Internal Server Error', { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  if (!(await requireAdmin())) {
    return new Response('Forbidden', { status: 403 });
  }
  try {
    const body = await request.json().catch(() => null);
    if (!body || typeof body !== 'object' || !body.lean) {
      return new Response('problem must include at least { lean }', {
        status: 400,
      });
    }
    const verified = !!body.verified;
    const record = {
      questionTitle: body.questionTitle ?? null,
      subtitle: body.subtitle ?? null,
      problem: body.problem ?? null,
      answer: body.answer ?? null,
      difficulty: body.difficulty ?? null,
      points: body.points ?? null,
      insight: body.insight ?? null,
      lean: body.lean,
      verified,
      proof: verified ? (body.proof ?? '') : '',
      error: body.error ?? null,
      toolchain: body.toolchain ?? 'leanprover/lean4:v4.29.1',
    };
    const count = await saveGenerated(record);
    // Verified ones additionally enter the promotable review queue.
    let queued: number | undefined;
    if (verified) {
      queued = await pushProblem({
        ...record,
        createdAt: new Date().toISOString(),
      });
    }
    return Response.json({ ok: true, count, queued });
  } catch (error) {
    console.error('Error saving generated problem:', error);
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
    const ok = await deleteGenerated(id);
    return ok
      ? Response.json({ ok: true })
      : new Response('Not found', { status: 404 });
  } catch (error) {
    console.error('Error deleting generated problem:', error);
    return new Response('Internal Server Error', { status: 500 });
  }
}
