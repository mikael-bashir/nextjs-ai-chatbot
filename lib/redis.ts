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
  // Every distinct-toolchain certificate accumulated pre-publish (see
  // GeneratedRecord.certs — same shape). Promote pushes ALL of them, not
  // just the single flat proof/toolchain above.
  certs?: GeneratedRecord['certs'];
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
  // Provenance of the verification, all stamped the instant the kernel confirmed
  // the proof and carried through staging → prod so CompeteMath stores these
  // exact values rather than re-deriving (or re-signing) them later.
  toolchain?: string;
  /** Mathlib version of the group that certified it — pairs with `toolchain`. */
  mathlib?: string;
  /** Specific strategy that enforced this proof, for the certificate's
   *  Enforcer line (e.g. "Leak Ultra Fleeting" instead of bland "Leak"). */
  enforcer?: string;
  verifiedAt?: string;
  signature?: string;
  signatureKeyId?: string;
  certMintedAt?: string;
  // Every distinct-toolchain certificate accumulated across re-verifies of
  // this item, upserted by toolchain — lets an admin verify on several
  // toolchains BEFORE ever promoting, and ship all of them as independent
  // certificates the first time this problem goes live. The flat fields
  // above always mirror the MOST RECENT verify (unchanged, for every
  // existing reader); this is the full accumulated set.
  certs?: Array<{
    toolchain: string;
    mathlib?: string | null;
    enforcer?: string | null;
    proof: string;
    verifiedAt?: string | null;
    signature?: string | null;
    signatureKeyId?: string | null;
    certMintedAt?: string | null;
  }>;
  // Cost-estimator display state, persisted so the estimate (made on enqueue)
  // and the actual (recorded on verify) survive a page refresh. The learning
  // history lives separately in proof_cost_history; these mirror it per-card.
  estUsd?: number;
  estLow?: number;
  estHigh?: number;
  estRationale?: string;
  costHistoryId?: string;
  actualUsd?: number;
  // Saved verification progress: the latest resumable checkpoint from a have-tree
  // run (a partially-filled `have`-skeleton). Auto-persisted as holes bank, so a
  // stopped run (limit / terminate / crash) can resume instead of restarting.
  proofCheckpoint?: string;
  proofCheckpointFilled?: number;
  proofCheckpointTotal?: number;
  // Generation provenance: which mode produced it, the trapdoor key (hidden
  // layer chain — server-side only, never shown to solvers), and the
  // Sonnet-gauntlet verdict. See lib/generation/trapdoor.ts.
  genMode?: string | null;
  chain?: string[] | null;
  gauntlet?: {
    model: string;
    samples: number;
    verdicts: {
      cracked: boolean;
      claimedAnswer: string | null;
      reason: string;
    }[];
    solved: boolean;
    // Legacy field from the removed repair loop — present on old records only.
    mutations?: number;
    suspectAnswer?: string;
  } | null;
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
// The generated store is a Redis LIST of JSON blobs, and updateGenerated is a
// read-modify-write (lrange → merge → lset) which is NOT atomic. Two concurrent
// PATCHes for the same item — e.g. the (now instant) cost-estimate write racing
// the actual-cost write — would both read the same record and the last lset would
// clobber the other's field (symptom: an item shows only `actual`, no `estimate`,
// or vice-versa). The store has a single writer process per environment, so an
// in-process async lock that serialises every read-modify-write fully prevents
// the lost update. Cheap: these writes are human-paced, not high-QPS.
let generatedWriteChain: Promise<unknown> = Promise.resolve();
function serializeGeneratedWrite<T>(fn: () => Promise<T>): Promise<T> {
  const next = generatedWriteChain.then(fn, fn);
  // Keep the chain alive regardless of this write's outcome.
  generatedWriteChain = next.then(
    () => undefined,
    () => undefined,
  );
  return next;
}

// A patch is about to REPLACE a verified proof with an unverified/blank one.
// Recognizes both an explicit `verified: false` (a failed re-verify PATCH
// always sends this) and a patch that blanks `proof` outright. A `lean` edit
// in the SAME patch is a deliberate, legitimate invalidation (the statement
// itself changed — the old proof no longer applies to anything), so that case
// is excluded — updateGenerated() lets THAT one through.
function isDestructiveVerifyPatch(
  rec: GeneratedRecord,
  patch: Partial<GeneratedRecord>,
): boolean {
  if (!rec.verified || !rec.proof?.trim()) return false;
  if ('lean' in patch && patch.lean !== rec.lean) return false;
  const goingUnverified = patch.verified === false;
  const blankingProof = 'proof' in patch && !patch.proof?.trim();
  return goingUnverified || blankingProof;
}

// Snapshot every certificate this record currently carries — the flat
// verified/proof/toolchain fields (always present when `verified`) plus any
// additional toolchains already accumulated in `certs[]`. Called whenever a
// destructive patch is caught (belt-and-braces: updateGenerated() no longer
// lets it touch the live record, but this keeps a durable copy regardless).
// Fire-and-forget: a backup failure must never block or fail the actual
// re-verify PATCH the operator is waiting on.
function backupBeforeOverwrite(rec: GeneratedRecord): void {
  void (async () => {
    try {
      const { backupProof } = await import('./db/proof-backup-queries');
      const seen = new Set<string>();
      const attempts = [
        { toolchain: rec.toolchain, proof: rec.proof, strategy: rec.enforcer },
        ...(rec.certs ?? []).map((c) => ({
          toolchain: c.toolchain,
          proof: c.proof,
          strategy: c.enforcer,
        })),
      ];
      for (const a of attempts) {
        if (!a.toolchain || !a.proof?.trim() || seen.has(a.toolchain)) continue;
        seen.add(a.toolchain);
        await backupProof({
          lean: rec.lean,
          toolchain: a.toolchain,
          proof: a.proof,
          questionTitle: rec.questionTitle ?? null,
          strategy: a.strategy ?? null,
        });
      }
    } catch {
      /* best-effort — see comment above */
    }
  })();
}

export async function updateGenerated(
  id: string,
  patch: Partial<GeneratedRecord>,
): Promise<GeneratedRecord | null> {
  return serializeGeneratedWrite(async () => {
    const redis = getRedis();
    const raws: string[] = await redis.lrange(GENERATED_STORE_KEY, 0, -1);
    for (let i = 0; i < raws.length; i++) {
      try {
        const rec = JSON.parse(raws[i]) as GeneratedRecord;
        if (rec.id === id) {
          const destructive = isDestructiveVerifyPatch(rec, patch);
          if (destructive) backupBeforeOverwrite(rec);
          // A failed re-verify (or any patch that would blank a live
          // certificate) must never destroy it — keep verified/proof exactly
          // as they were; everything else in the patch (error message, cost
          // fields, etc.) still applies. Without this, staging/promote read
          // straight off these flat fields and a re-verify failure silently
          // erased an already-proven problem's certificate.
          const safePatch = destructive
            ? { ...patch, verified: rec.verified, proof: rec.proof }
            : patch;
          const updated = { ...rec, ...safePatch, id: rec.id };
          await redis.lset(GENERATED_STORE_KEY, i, JSON.stringify(updated));
          return updated;
        }
      } catch {
        /* skip malformed */
      }
    }
    return null;
  });
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

// A pool of evocative code-name titles in the house style (abstract, ominous,
// vaguely mathematical — the titles are NOT descriptions of the problem). On a
// collision we draw a FRESH name from here rather than tacking on a number, so a
// renamed problem is indistinguishable from a first-class generated one.
export const FALLBACK_TITLES = [
  'The Vanishing Point', 'Silent Cardinal', 'The Hollow Proof', 'Recursive Dawn',
  'False Vacuum', 'Infinite Descent', 'Terminal Value', 'Strange Attractor',
  'Zero Kelvin', 'The Heavy Tail', 'Dark Forest', 'Unstable Equilibrium',
  'The Omega Point', 'Irrational Roots', 'Violent Symmetry', 'The Killing Vector',
  'The Empty Set', 'Broken Ladder', 'Prime Suspect', 'The Last Residue',
  'Modular Ghost', 'The Golden Cut', "Fermat's Shadow", 'The Twisted Torus',
  "Cauchy's Veil", 'The Frozen Sum', 'Spectral Gap', 'The Lonely Runner',
  'Hidden Lattice', 'The Collatz Mirror', "Euler's Whisper", 'Broken Symmetry',
  "Cantor's Dust", 'The Final Digit', 'Parity Wall', 'The Sunken Curve',
  "Gauss's Silence", 'The Perfect Shroud', 'Vanishing Moment', 'The Iron Bound',
  'Convex Ruin', 'The Divided Kingdom', 'Root of Ruin', 'The Missing Angle',
  "Hilbert's Echo", 'The Endless Staircase', 'The Narrow Margin', 'Countable Chaos',
  'The Frozen Orbit', "Riemann's Ghost", 'The Silent Sieve', 'Null Horizon',
  'The Crooked Line', "Abel's Regret", 'The Tangent Line', 'Forbidden Minor',
  'The Empty Product', 'The Third Root', 'Pigeonhole Paradox', 'The Sealed Urn',
  'Chromatic Storm', 'The Bounded Infinite', 'Pale Constant', 'The Vanishing Gap',
  'Orthogonal Fate', 'The Last Partition', 'Weighted Silence', 'Nine Point Circle',
  'The Hidden Symmetry', 'Cold Equation', 'The Recursive Tomb', 'Fractal Verdict',
  'The Sparse Matrix', "Euclid's Nightmare", "The Architect's Flaw", 'A Quiet Variable',
  'The Third Body', 'Proof by Exhaustion', 'The Heavy Sphere', 'Boundary Condition',
  'The Prime Gap', 'Twin Paradox', 'The Weighted Coin', "Markov's Curse",
  'The Empty Interval', 'Diverging Series', 'The Fixed Point', "Brouwer's Ghost",
  'The Knotted Path', 'Genus Zero', 'The Sealed Envelope', 'Non-Trivial Zero',
  'The Perfect Cover', "Ramsey's Threshold", 'The Isolated Vertex', 'Spanning Ruin',
  'The Broken Graph', 'Degrees of Freedom', 'The Silent Automaton', 'Undecidable',
  'The Frozen Fraction', 'Continued Silence', 'Rational Storm', 'Singular Matrix',
  'The Hollow Cylinder', 'Torus Knot', 'The Golden Angle', "Fibonacci's Curse",
  'The Broken Spiral', 'Logarithmic Fall', 'The Steep Descent', 'Saddle Point',
  'The Narrow Path', 'Convergent Doom', 'The Empty Lattice', "Zeta's Shadow",
  'The Critical Line', 'Analytic Ruin', "Galois Silence", 'Radical Extension',
  'The Broken Ring', 'Ideal Boundary', 'The Prime Ideal', "Noether's Ghost",
  'The Vanishing Ideal', 'Spectral Ruin',
]

// Return a display title guaranteed not to collide (by normTitle) with any in
// `taken`. If `desired` is free it's kept as-is; otherwise (or if it's empty) we
// draw a fresh, unused code-name from FALLBACK_TITLES rather than numbering it,
// so a renamed problem reads like any other. Only if the entire pool is taken do
// we fall back to a timestamp suffix. This keeps a newly generated problem unique
// against the current roster so the title-keyed dedupe guards can never mis-fire.
export function disambiguateTitle(
  desired: string | null | undefined,
  taken: Set<string>,
): string {
  const base = (desired || '').trim();
  if (base && !taken.has(normTitle(base))) return base;
  const free = FALLBACK_TITLES.filter((n) => !taken.has(normTitle(n)));
  if (free.length) return free[Math.floor(Math.random() * free.length)];
  // Pathological fallback (whole pool exhausted) — a timestamp is ~always unique.
  return `${base || 'Generated Problem'} (${Date.now().toString(36)})`;
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
