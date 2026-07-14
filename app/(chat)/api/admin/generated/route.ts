import type { NextRequest } from 'next/server';
import { auth } from '@/app/(auth)/auth';
import { isAdminEmail } from '@/lib/admin';
import {
  GENERATED_CAP,
  deleteGenerated,
  disambiguateTitle,
  listGenerated,
  listProblems,
  listProdProblems,
  normTitle,
  pushProblem,
  queueLength,
  saveGenerated,
  updateGenerated,
} from '@/lib/redis';

// Titles already on the roster — generated history + both Redis queues + the
// live CompeteMath set — so a new problem's title can be made unique against
// all of them. Live is best-effort: a CompeteMath outage never blocks a save.
async function rosterTitles(): Promise<Set<string>> {
  const set = new Set<string>();
  const add = (t?: string | null) => {
    const n = normTitle(t);
    if (n) set.add(n);
  };
  const [gen, staging, prod] = await Promise.all([
    listGenerated().catch(() => []),
    listProblems().catch(() => []),
    listProdProblems().catch(() => []),
  ]);
  gen.forEach((g) => add(g.questionTitle));
  staging.forEach((s) => add(s.questionTitle));
  prod.forEach((p) => add(p.questionTitle));
  try {
    const base = (
      process.env.COMPETEMATH_BASE_URL || 'https://www.competemath.com'
    ).replace(/\/$/, '');
    const r = await fetch(`${base}/api/problems`, {
      next: { revalidate: 3600 },
    });
    if (r.ok) {
      const rows = await r.json();
      if (Array.isArray(rows)) {
        for (const x of rows) add((x as { title?: string })?.title);
      }
    }
  } catch {
    /* live set unavailable — dedupe against the queues only */
  }
  return set;
}

// The full generation history: every problem Claude produces is stored here,
// verified or not, so nothing is ever silently discarded. Capped at
// GENERATED_CAP server-side. Verified problems are ALSO pushed to the staging
// review queue for promotion to prod.
async function requireAdmin() {
  const session = await auth();
  return isAdminEmail(session?.user?.email) ? session : null;
}

// Cost-estimator ingest (self-hosted service, internal network). No-op unless
// ESTIMATOR_URL is set. Best-effort: swallow every error so telemetry can never
// affect the admin flow.
const ESTIMATOR_URL = (process.env.ESTIMATOR_URL || '').replace(/\/$/, '');
async function ingestCostExample(rec: Record<string, unknown>): Promise<void> {
  if (!ESTIMATOR_URL) return;
  const signature = rec.lean;
  const cost = rec.actualUsd;
  if (typeof signature !== 'string' || !signature || typeof cost !== 'number') return;
  try {
    await fetch(`${ESTIMATOR_URL}/ingest`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        signature,
        proved: !!rec.verified,
        actualCostUsd: cost,
        model: typeof rec.model === 'string' ? rec.model : null,
        source: 'verifier',
      }),
    });
  } catch {
    /* estimator down/absent — ignore */
  }
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
    // Guarantee the title can't collide with anything already on the roster: if
    // it does, disambiguateTitle swaps in a fresh code-name (not a number).
    // Since a verified record is also pushed to staging below with this same
    // title, the uniqueness propagates all the way to prod, so the title-keyed
    // dedupe guards can never mis-fire.
    const questionTitle = disambiguateTitle(
      body.questionTitle,
      await rosterTitles(),
    );
    const record = {
      questionTitle,
      subtitle: body.subtitle ?? null,
      problem: body.problem ?? null,
      answer: body.answer ?? null,
      difficulty: body.difficulty ?? null,
      points: body.points ?? null,
      level: body.level ?? null,
      insight: body.insight ?? null,
      lean: body.lean,
      verified,
      proof: verified ? (body.proof ?? '') : '',
      error: body.error ?? null,
      // Whether it should sit in the (DB-backed) verification queue.
      queued: !!body.queued,
      toolchain: body.toolchain ?? 'leanprover/lean4:v4.29.1',
    };
    const item = await saveGenerated(record);
    // Verified ones additionally enter the promotable review queue.
    let staged: unknown;
    let queued: number | undefined;
    if (verified) {
      staged = await pushProblem({
        ...record,
        createdAt: new Date().toISOString(),
      });
      queued = await queueLength();
    }
    // Return the stored records so the client can update state without a refetch.
    return Response.json({ ok: true, item, staged, queued });
  } catch (error) {
    console.error('Error saving generated problem:', error);
    return new Response('Internal Server Error', { status: 500 });
  }
}

// Re-verification updates a stored problem's outcome in place. It does NOT push
// to staging — that stays a deliberate, manual action.
export async function PATCH(request: NextRequest) {
  if (!(await requireAdmin())) {
    return new Response('Forbidden', { status: 403 });
  }
  try {
    const body = await request.json().catch(() => null);
    if (!body?.id || typeof body.id !== 'string') {
      return new Response('id required', { status: 400 });
    }
    const patch: Record<string, unknown> = {};
    if ('verified' in body) patch.verified = !!body.verified;
    if ('proof' in body) patch.proof = body.proof ?? '';
    if ('error' in body) patch.error = body.error ?? null;
    if ('queued' in body) patch.queued = !!body.queued;
    // Cost-estimator display fields — persisted so the estimate/actual survive a
    // refresh (they mirror the proof_cost_history row driving the scoreboard).
    for (const k of [
      'estUsd',
      'estLow',
      'estHigh',
      'estRationale',
      'costHistoryId',
      'actualUsd',
      // Saved verification progress (resumable have-tree checkpoint).
      'proofCheckpoint',
      'proofCheckpointFilled',
      'proofCheckpointTotal',
    ] as const) {
      if (k in body) patch[k] = body[k];
    }
    const updated = await updateGenerated(body.id, patch);
    // When actual cost lands, stream the labelled example to the cost-estimator
    // service (it learns cost from the Lean signature alone). Fire-and-forget,
    // server-side over the internal network — never blocks or fails the PATCH.
    if (updated && 'actualUsd' in patch) {
      void ingestCostExample(updated as unknown as Record<string, unknown>);
    }
    return updated
      ? Response.json({ ok: true, item: updated })
      : new Response('Not found', { status: 404 });
  } catch (error) {
    console.error('Error updating generated problem:', error);
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
