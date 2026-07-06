import 'server-only';

import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import { sql as vercelSql } from '@vercel/postgres';
import { drizzle } from 'drizzle-orm/vercel-postgres';

import {
  agentRunLog,
  apiKey,
  problemJob,
  type AgentRunLog,
  type ApiKey,
  type ProblemJob,
} from './schema';

if (!process.env.POSTGRES_URL) {
  throw new Error('POSTGRES_URL environment variable is not set.');
}

// Self-contained client for the Leak API-service domain. drizzle-orm's
// vercel-postgres adapter is stateless (HTTP), so a second instance is cheap
// and keeps this feature decoupled from the large legacy queries.ts.
const db = drizzle(vercelSql, { schema: { apiKey, problemJob, agentRunLog } });

// ---------------------------------------------------------------------------
// Admin debug log — full agent context + outcome per prover run (admin only).
// ---------------------------------------------------------------------------
export async function createAgentRunLog(input: {
  userId?: string | null;
  source: string;
  theorem: string;
  model?: string | null;
  prompt?: string | null;
  mcpServers?: unknown;
  verified?: boolean | null;
  proof?: string | null;
  finalText?: string | null;
  metrics?: unknown;
}): Promise<AgentRunLog> {
  const [row] = await db
    .insert(agentRunLog)
    .values({
      userId: input.userId ?? null,
      source: input.source,
      theorem: input.theorem,
      model: input.model ?? null,
      prompt: input.prompt ?? null,
      mcpServers: input.mcpServers ?? null,
      verified: input.verified ?? null,
      proof: input.proof ?? null,
      finalText: input.finalText ?? null,
      metrics: input.metrics ?? null,
    })
    .returning();
  return row;
}

export async function listAgentRunLogs(limit = 50): Promise<AgentRunLog[]> {
  return db
    .select()
    .from(agentRunLog)
    .orderBy(desc(agentRunLog.createdAt))
    .limit(limit);
}

// ---------------------------------------------------------------------------
// API keys
// ---------------------------------------------------------------------------

export async function createApiKey({
  userId,
  name,
  keyHash,
  prefix,
}: {
  userId: string;
  name: string;
  keyHash: string;
  prefix: string;
}): Promise<ApiKey> {
  const [row] = await db
    .insert(apiKey)
    .values({ userId, name, keyHash, prefix, createdAt: new Date() })
    .returning();
  return row;
}

/** Active (non-revoked) keys for a user, newest first — for the dashboard. */
export async function listApiKeys({
  userId,
}: {
  userId: string;
}): Promise<ApiKey[]> {
  return db
    .select()
    .from(apiKey)
    .where(and(eq(apiKey.userId, userId), isNull(apiKey.revokedAt)))
    .orderBy(desc(apiKey.createdAt));
}

/** Auth lookup: resolve a key hash to its (active) row, or null. */
export async function getActiveApiKeyByHash(
  keyHash: string,
): Promise<ApiKey | null> {
  const [row] = await db
    .select()
    .from(apiKey)
    .where(and(eq(apiKey.keyHash, keyHash), isNull(apiKey.revokedAt)))
    .limit(1);
  return row ?? null;
}

/** Soft-revoke; scoped to the owner so one user can't revoke another's key. */
export async function revokeApiKey({
  id,
  userId,
}: {
  id: string;
  userId: string;
}): Promise<boolean> {
  const rows = await db
    .update(apiKey)
    .set({ revokedAt: new Date() })
    .where(
      and(
        eq(apiKey.id, id),
        eq(apiKey.userId, userId),
        isNull(apiKey.revokedAt),
      ),
    )
    .returning({ id: apiKey.id });
  return rows.length > 0;
}

/** Best-effort last-used stamp; failures here must never block a request. */
export async function touchApiKey(id: string): Promise<void> {
  try {
    await db
      .update(apiKey)
      .set({ lastUsedAt: new Date() })
      .where(eq(apiKey.id, id));
  } catch {
    /* non-fatal */
  }
}

// ---------------------------------------------------------------------------
// Deployment queue (ProblemJob)
// ---------------------------------------------------------------------------

export async function enqueueJob({
  userId,
  apiKeyId,
  problem,
  isMock = false,
  pricingClass,
  quotedCredits,
}: {
  userId: string;
  apiKeyId?: string | null;
  problem: string;
  isMock?: boolean;
  pricingClass?: string | null;
  quotedCredits?: number | null;
}): Promise<ProblemJob> {
  const [row] = await db
    .insert(problemJob)
    .values({
      userId,
      apiKeyId: apiKeyId ?? null,
      problem,
      isMock,
      status: 'queued',
      pricingClass: pricingClass ?? null,
      quotedCredits: quotedCredits ?? null,
      createdAt: new Date(),
    })
    .returning();
  return row;
}

/** A single job, optionally scoped to its owner (used by the poll endpoint). */
export async function getJobById({
  id,
  userId,
}: {
  id: string;
  userId?: string;
}): Promise<ProblemJob | null> {
  const where = userId
    ? and(eq(problemJob.id, id), eq(problemJob.userId, userId))
    : eq(problemJob.id, id);
  const [row] = await db.select().from(problemJob).where(where).limit(1);
  return row ?? null;
}

export async function listJobsByUser({
  userId,
  limit = 50,
}: {
  userId: string;
  limit?: number;
}): Promise<ProblemJob[]> {
  return db
    .select()
    .from(problemJob)
    .where(eq(problemJob.userId, userId))
    .orderBy(desc(problemJob.createdAt))
    .limit(limit);
}

/**
 * Atomically claim the oldest claimable job for a worker. "Claimable" = queued,
 * or previously leased/proving but whose lease has expired (dead worker). The
 * single-statement UPDATE ... WHERE id = (SELECT ... FOR UPDATE SKIP LOCKED)
 * guarantees two concurrent workers never grab the same row.
 */
export async function leaseNextJob({
  workerId,
  leaseMs,
}: {
  workerId: string;
  leaseMs: number;
}): Promise<ProblemJob | null> {
  const result = await db.execute(sql`
    UPDATE "ProblemJob"
    SET status = 'leased',
        "leasedBy" = ${workerId},
        "leasedAt" = now(),
        "heartbeatAt" = now(),
        "leaseExpiresAt" = now() + (${leaseMs} || ' milliseconds')::interval,
        attempts = attempts + 1
    WHERE id = (
      SELECT id FROM "ProblemJob"
      WHERE status = 'queued'
         OR (status IN ('leased', 'proving') AND "leaseExpiresAt" < now())
      ORDER BY "createdAt" ASC
      FOR UPDATE SKIP LOCKED
      LIMIT 1
    )
    RETURNING *;
  `);
  return (result.rows[0] as ProblemJob) ?? null;
}

/** Extend a lease + mark progress. Scoped to the leasing worker. */
export async function heartbeatJob({
  id,
  workerId,
  leaseMs,
  status,
}: {
  id: string;
  workerId: string;
  leaseMs: number;
  status?: 'leased' | 'proving';
}): Promise<boolean> {
  const rows = await db
    .update(problemJob)
    .set({
      heartbeatAt: new Date(),
      leaseExpiresAt: new Date(Date.now() + leaseMs),
      ...(status ? { status } : {}),
    })
    .where(
      and(eq(problemJob.id, id), eq(problemJob.leasedBy, workerId)),
    )
    .returning({ id: problemJob.id });
  return rows.length > 0;
}

/**
 * Resolve a mock job immediately (no worker involved). Used so a new user can
 * exercise the submit→poll flow the moment they have a key. Free by design.
 */
export async function resolveMockJob({
  id,
  proof,
}: {
  id: string;
  proof: string;
}): Promise<ProblemJob | null> {
  const [row] = await db
    .update(problemJob)
    .set({
      status: 'proved',
      proof,
      chargedCredits: 0,
      finishedAt: new Date(),
    })
    .where(eq(problemJob.id, id))
    .returning();
  return row ?? null;
}

/** Mark a job proved with its result + telemetry. Scoped to the leasing worker. */
export async function completeJob({
  id,
  workerId,
  proof,
  chargedCredits,
  tokensInput,
  tokensOutput,
  modelId,
}: {
  id: string;
  workerId: string;
  proof: string;
  chargedCredits?: number | null;
  tokensInput?: number | null;
  tokensOutput?: number | null;
  modelId?: string | null;
}): Promise<ProblemJob | null> {
  const [row] = await db
    .update(problemJob)
    .set({
      status: 'proved',
      proof,
      chargedCredits: chargedCredits ?? null,
      tokensInput: tokensInput ?? null,
      tokensOutput: tokensOutput ?? null,
      modelId: modelId ?? null,
      finishedAt: new Date(),
    })
    .where(and(eq(problemJob.id, id), eq(problemJob.leasedBy, workerId)))
    .returning();
  return row ?? null;
}

// ---------------------------------------------------------------------------
// Admin console — the operator resolving queries by hand from their local
// device (the "local resolving" path, alongside the automated worker). These
// bypass worker-lease scoping because the admin is a trusted override.
// ---------------------------------------------------------------------------

/** Recent real (non-mock) jobs for the admin queue console, newest first. */
export async function listAdminJobs({
  limit = 50,
}: {
  limit?: number;
}): Promise<ProblemJob[]> {
  return db
    .select()
    .from(problemJob)
    .where(eq(problemJob.isMock, false))
    .orderBy(desc(problemJob.createdAt))
    .limit(limit);
}

/** Admin marks a job proved (override — no worker lease needed). */
export async function adminResolveProved({
  id,
  proof,
  chargedCredits,
  modelId,
}: {
  id: string;
  proof: string;
  chargedCredits?: number | null;
  modelId?: string | null;
}): Promise<ProblemJob | null> {
  const [row] = await db
    .update(problemJob)
    .set({
      status: 'proved',
      proof,
      leasedBy: 'admin',
      chargedCredits: chargedCredits ?? null,
      modelId: modelId ?? null,
      finishedAt: new Date(),
    })
    .where(eq(problemJob.id, id))
    .returning();
  return row ?? null;
}

/** Admin marks a job failed (override). Money-back: chargedCredits stays 0. */
export async function adminResolveFailed({
  id,
  error,
}: {
  id: string;
  error: string;
}): Promise<ProblemJob | null> {
  const [row] = await db
    .update(problemJob)
    .set({
      status: 'failed',
      resultError: error,
      leasedBy: 'admin',
      chargedCredits: 0,
      finishedAt: new Date(),
    })
    .where(eq(problemJob.id, id))
    .returning();
  return row ?? null;
}

/** Mark a job failed (money-back: chargedCredits stays 0). */
export async function failJob({
  id,
  workerId,
  error,
  tokensInput,
  tokensOutput,
  modelId,
}: {
  id: string;
  workerId: string;
  error: string;
  tokensInput?: number | null;
  tokensOutput?: number | null;
  modelId?: string | null;
}): Promise<ProblemJob | null> {
  const [row] = await db
    .update(problemJob)
    .set({
      status: 'failed',
      resultError: error,
      chargedCredits: 0,
      tokensInput: tokensInput ?? null,
      tokensOutput: tokensOutput ?? null,
      modelId: modelId ?? null,
      finishedAt: new Date(),
    })
    .where(and(eq(problemJob.id, id), eq(problemJob.leasedBy, workerId)))
    .returning();
  return row ?? null;
}
