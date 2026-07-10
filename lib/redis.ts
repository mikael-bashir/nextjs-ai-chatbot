import 'server-only';

import Redis from 'ioredis';

// Two separate Redis instances, deliberately kept distinct:
//   - staging  (REDIS_URL)             : this sub-service's review queue
//   - prod     (COMPETEMATH_REDIS_URL) : the main CompeteMath app's live queue
// (mirrors the singleton pattern in lib/pricing.ts).

// ioredis rejects commands with a generic "Reached the max retries per request
// limit" message that hides the real cause (bad host, refused, auth). Capture
// the underlying connection error off the `error` event so health checks can
// report it (e.g. "ENOTFOUND <host>") instead of the useless wrapper.
const lastConnError = new WeakMap<Redis, string>();
function withErrorCapture(client: Redis): Redis {
  client.on('error', (e: unknown) => {
    const err = e as { code?: string; message?: string };
    lastConnError.set(
      client,
      `${err?.code ? `${err.code} ` : ''}${err?.message || String(e)}`.trim(),
    );
  });
  return client;
}

let _redis: Redis | null = null;
export function getRedis(): Redis {
  if (!_redis) {
    _redis = withErrorCapture(
      new Redis(process.env.REDIS_URL!, {
        lazyConnect: true,
        maxRetriesPerRequest: 2,
      }),
    );
  }
  return _redis;
}

let _prodRedis: Redis | null = null;
export function getCompetemathRedis(): Redis {
  if (!_prodRedis) {
    _prodRedis = withErrorCapture(
      new Redis(process.env.COMPETEMATH_REDIS_URL!, {
        lazyConnect: true,
        maxRetriesPerRequest: 2,
      }),
    );
  }
  return _prodRedis;
}

// Staging queue: generated + Lean-verified problems awaiting review.
export const PROBLEM_QUEUE_KEY = 'competemath:problems:queue';
// Production queue consumed by the main app's weekly-problems cron via LPOP.
export const PROD_QUEUE_KEY = 'weekly-problems';
// Full generation history — EVERY problem produced (verified or not) is kept
// here for browsing, capped so it can't grow unbounded.
export const GENERATED_STORE_KEY = 'competemath:problems:generated';
export const GENERATED_CAP = 200;

export interface StagedProblem {
  id: string;
  questionTitle?: string;
  subtitle?: string;
  problem?: string;
  answer?: number | string | null;
  difficulty?: string;
  points?: number;
  // Prerequisite-knowledge level 1-5 (see admin-pipeline BASE_REQS). Flows to
  // CompeteMath as `knowledge: "Level N"` on promotion.
  level?: number;
  insight?: string;
  lean: string;
  proof: string;
  toolchain?: string;
  createdAt: string;
}

export async function pushProblem(
  problem: Record<string, unknown>,
): Promise<StagedProblem> {
  // Stamp a stable id so the item can later be targeted for delete/promote.
  const record = { id: crypto.randomUUID(), ...problem } as StagedProblem;
  // LPUSH so consumers RPOP/LPOP in FIFO order; return the stored record so the
  // client can update its list without re-fetching.
  await getRedis().lpush(PROBLEM_QUEUE_KEY, JSON.stringify(record));
  return record;
}

export async function queueLength(): Promise<number> {
  return getRedis().llen(PROBLEM_QUEUE_KEY);
}

export async function listProblems(): Promise<StagedProblem[]> {
  const raws: string[] = await getRedis().lrange(PROBLEM_QUEUE_KEY, 0, -1);
  return raws
    .map((r: string): StagedProblem | null => {
      try {
        return JSON.parse(r) as StagedProblem;
      } catch {
        return null;
      }
    })
    .filter((x: StagedProblem | null): x is StagedProblem => !!x);
}

// Remove the staged item whose id matches; returns the removed record or null.
export async function deleteProblem(id: string): Promise<StagedProblem | null> {
  const redis = getRedis();
  const raws = await redis.lrange(PROBLEM_QUEUE_KEY, 0, -1);
  for (const raw of raws) {
    try {
      const rec = JSON.parse(raw) as StagedProblem;
      if (rec.id === id) {
        // LREM by the exact stored string (count 1) — precise, id-targeted.
        await redis.lrem(PROBLEM_QUEUE_KEY, 1, raw);
        return rec;
      }
    } catch {
      /* skip malformed */
    }
  }
  return null;
}

export interface GeneratedRecord {
  id: string;
  questionTitle?: string;
  subtitle?: string;
  problem?: string;
  answer?: number | string | null;
  difficulty?: string;
  points?: number;
  level?: number;
  insight?: string;
  lean: string;
  verified: boolean;
  proof?: string;
  error?: string | null;
  // DB-backed membership of the verification queue, so a queued problem survives
  // reloads and the verifier can resume it later.
  queued?: boolean;
  toolchain?: string;
  createdAt: string;
}

// Save a generated problem to the history store. Server stamps id + createdAt,
// then LTRIMs so at most GENERATED_CAP records are retained (oldest dropped).
export async function saveGenerated(
  rec: Record<string, unknown>,
): Promise<GeneratedRecord> {
  const redis = getRedis();
  const record = {
    ...rec,
    id: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
  } as GeneratedRecord;
  await redis.lpush(GENERATED_STORE_KEY, JSON.stringify(record));
  await redis.ltrim(GENERATED_STORE_KEY, 0, GENERATED_CAP - 1);
  return record;
}

export async function listGenerated(): Promise<GeneratedRecord[]> {
  const raws: string[] = await getRedis().lrange(GENERATED_STORE_KEY, 0, -1);
  return raws
    .map((r: string): GeneratedRecord | null => {
      try {
        return JSON.parse(r) as GeneratedRecord;
      } catch {
        return null;
      }
    })
    .filter((x: GeneratedRecord | null): x is GeneratedRecord => !!x);
}

export async function generatedCount(): Promise<number> {
  return getRedis().llen(GENERATED_STORE_KEY);
}

export async function deleteGenerated(id: string): Promise<boolean> {
  const redis = getRedis();
  const raws: string[] = await redis.lrange(GENERATED_STORE_KEY, 0, -1);
  for (const raw of raws) {
    try {
      if ((JSON.parse(raw) as GeneratedRecord).id === id) {
        await redis.lrem(GENERATED_STORE_KEY, 1, raw);
        return true;
      }
    } catch {
      /* skip malformed */
    }
  }
  return false;
}

// Merge a patch into the stored generated record in place (used by re-verify).
export async function updateGenerated(
  id: string,
  patch: Partial<GeneratedRecord>,
): Promise<GeneratedRecord | null> {
  const redis = getRedis();
  const raws: string[] = await redis.lrange(GENERATED_STORE_KEY, 0, -1);
  for (let i = 0; i < raws.length; i++) {
    try {
      const rec = JSON.parse(raws[i]) as GeneratedRecord;
      if (rec.id === id) {
        const updated = { ...rec, ...patch, id: rec.id };
        await redis.lset(GENERATED_STORE_KEY, i, JSON.stringify(updated));
        return updated;
      }
    } catch {
      /* skip malformed */
    }
  }
  return null;
}

// Push a payload onto the production weekly-problems queue (separate instance).
export async function pushToProd(
  payload: Record<string, unknown>,
): Promise<number> {
  return getCompetemathRedis().lpush(PROD_QUEUE_KEY, JSON.stringify(payload));
}

export async function prodQueueLength(): Promise<number> {
  return getCompetemathRedis().llen(PROD_QUEUE_KEY);
}

// Peek the production weekly-problems queue (items awaiting the CompeteMath cron
// that drains them into the live `questions` table). Read-only; used so the
// admin pipeline can flag which generated problems are already sitting in prod.
// The prod payload shape (see the promote route) carries questionTitle but not
// the Lean statement, so title is the only cross-store key.
export async function listProdProblems(): Promise<
  Array<{ questionTitle?: string }>
> {
  const raws: string[] = await getCompetemathRedis().lrange(
    PROD_QUEUE_KEY,
    0,
    -1,
  );
  return raws
    .map((r) => {
      try {
        return JSON.parse(r) as { questionTitle?: string };
      } catch {
        return null;
      }
    })
    .filter((x): x is { questionTitle?: string } => !!x);
}

// Canonical title key for de-duping a problem across the queues (case- and
// whitespace-insensitive). Mirrors the client's normTitle in admin-pipeline.
export function normTitle(s?: string | null): string {
  return (s || '').toLowerCase().replace(/\s+/g, ' ').trim();
}

// Return a display title guaranteed not to collide (by normTitle) with any in
// `taken`. If `desired` is free it's returned as-is; otherwise a " (2)", " (3)",
// … suffix is appended until it's unique. This is how a newly generated problem
// is kept unique against the current roster so the title-keyed dedupe guards can
// never mis-fire.
export function disambiguateTitle(
  desired: string | null | undefined,
  taken: Set<string>,
): string {
  const base = (desired || 'Generated Problem').trim() || 'Generated Problem';
  if (!taken.has(normTitle(base))) return base;
  for (let i = 2; i < 1000; i++) {
    const candidate = `${base} (${i})`;
    if (!taken.has(normTitle(candidate))) return candidate;
  }
  // Pathological fallback — a timestamp suffix is effectively always unique.
  return `${base} (${Date.now().toString(36)})`;
}

// True iff a problem with this (normalized) title is already in the staging /
// prod queue. Empty/absent titles never match, so an untitled manual push is
// never blocked. These back the server-side guards that stop a problem being
// double-queued even if the UI is stale.
export async function stagingHasTitle(title?: string | null): Promise<boolean> {
  const t = normTitle(title);
  if (!t) return false;
  return (await listProblems()).some((p) => normTitle(p.questionTitle) === t);
}
export async function prodHasTitle(title?: string | null): Promise<boolean> {
  const t = normTitle(title);
  if (!t) return false;
  return (await listProdProblems()).some(
    (p) => normTitle(p.questionTitle) === t,
  );
}

// Health probe for both instances: reports reachability + queue length so the
// admin UI can surface Redis issues immediately.
export async function redisHealth(): Promise<{
  staging: { ok: boolean; length?: number; error?: string };
  prod: { ok: boolean; length?: number; error?: string };
}> {
  const probe = async (getClient: () => Redis, key: string) => {
    const client = getClient();
    try {
      // Race against a timeout so an unreachable host reports a clear error
      // quickly instead of hanging on ioredis's reconnect backoff.
      const timeout = new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error('connection timed out after 5s')),
          5000,
        ),
      );
      return {
        ok: true,
        length: await Promise.race([client.llen(key), timeout]),
      };
    } catch (e) {
      const wrapper = String((e as Error)?.message || e);
      // ioredis's "max retries"/"Connection is closed" wrappers hide the cause —
      // prefer the real connection error we captured off the `error` event.
      const real = lastConnError.get(client);
      const useReal =
        real && /max retries per request|connection is closed/i.test(wrapper);
      return { ok: false, error: useReal ? real : wrapper };
    }
  };
  const [staging, prod] = await Promise.all([
    probe(getRedis, PROBLEM_QUEUE_KEY),
    probe(getCompetemathRedis, PROD_QUEUE_KEY),
  ]);
  return { staging, prod };
}
