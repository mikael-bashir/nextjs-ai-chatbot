import type { ProverMetrics } from '@/lib/prover/types';
import {
  ARCHITECT_MATHLIB_VERSION,
  ARCHITECT_TOOLCHAIN,
  MATHLIB_VERSION,
  TOOLCHAIN,
  isArchitectStrategy,
  isRiverStrategy,
  isUltraStrategy,
} from '@/lib/prover/strategies';

// One research row per verification ATTEMPT, filed into whichever table matches
// the strategy that ran — Leak River (architect/grok), Leak Ultra (architect/
// Claude CLI) or Leak Stronghold (every other Claude-driven strategy). Shared by
// the ACG pipeline and the benchmark console so both produce identical rows.
//
// Recording must never affect the caller's loop: every failure is swallowed and
// reported as `null`.
export interface ResearchRunInput {
  /** The GeneratedProblem this attempt came from, when there is one. */
  generatedItemId?: string | null;
  problemTitle?: string | null;
  difficulty?: string | null;
  /** The sorried theorem that was handed to the prover. */
  sorriedTheorem: string;
  strategy: string;
  model: string;
  verified: boolean;
  refuted: boolean;
  costUsd?: number;
  computeBudgetMs?: number;
  metrics?: ProverMetrics;
  finalProof: string;
  error: string | null;
  /** Whether an NL proof seeded blueprint generation (river only). */
  nlSeedUsed?: boolean;
  /** Whether the attempt resumed from a banked checkpoint (stronghold only). */
  seedUsed?: boolean;
  /** Free-text provenance, e.g. `benchmark:fatex:<runId>`. */
  notes?: string | null;
}

export function researchPathFor(strategy: string): string {
  return isRiverStrategy(strategy)
    ? '/api/admin/research/river'
    : isUltraStrategy(strategy)
      ? '/api/admin/research/ultra'
      : '/api/admin/research/stronghold';
}

/** Build the POST body without sending it (exported for tests/inspection). */
export function researchBodyFor(args: ResearchRunInput): Record<string, unknown> {
  const {
    strategy,
    model,
    verified,
    refuted,
    costUsd,
    computeBudgetMs,
    metrics,
    finalProof,
    error,
    nlSeedUsed,
    seedUsed,
  } = args;
  const theoremName =
    /(?:theorem|lemma)\s+([A-Za-z_][\w'.]*)/.exec(args.sorriedTheorem || '')?.[1] ??
    null;
  const common = {
    generatedItemId: args.generatedItemId ?? null,
    problemTitle: args.problemTitle ?? null,
    difficulty: args.difficulty ?? null,
    theoremName,
    sorriedTheorem: args.sorriedTheorem || '',
    model: model || null,
    // Every model that actually served a call. The bridge reports this for
    // River runs (driver + any ladder fallback + the Sonnet seed); for the
    // Claude strategies the configured model is the only one that runs.
    modelsUsed: metrics?.models_used?.length
      ? metrics.models_used
      : model
        ? [model]
        : null,
    verified,
    refuted,
    costUsd: costUsd ?? null,
    computeBudgetMs: computeBudgetMs ?? null,
    timeElapsedS: metrics?.time_elapsed ?? null,
    llmCalls: metrics?.llm_invocations ?? null,
    toolCalls: metrics?.tools_invoked ?? null,
    finalProof: finalProof || null,
    error,
    bridgeBuild: metrics?.bridge_build ?? null,
    notes: args.notes ?? null,
    // The toolchain that ACTUALLY certified this run, as reported by the bridge
    // from the armed verifier group. Falling back to the group implied by the
    // strategy keeps older bridges honest rather than defaulting every row to
    // 4.29.1, which would be a false claim for architect runs.
    leanToolchain:
      metrics?.lean_toolchain ??
      (isArchitectStrategy(strategy) ? ARCHITECT_TOOLCHAIN : TOOLCHAIN),
    mathlibVersion:
      metrics?.mathlib_version ??
      (isArchitectStrategy(strategy) ? ARCHITECT_MATHLIB_VERSION : MATHLIB_VERSION),
  };

  if (isUltraStrategy(strategy)) {
    return {
      ...common,
      strategy,
      // Claude CLI driver: one authoritative cost, one combined token total —
      // no per-bucket counts and no driver/seed split to report.
      tokens: metrics?.tokens ?? null,
      costCapHit: metrics?.cost_cap_hit ?? null,
      maxIters: metrics?.max_iters ?? null,
      blueprintIterations: metrics?.blueprint_iterations ?? null,
      nodesTotal: metrics?.nodes_total ?? null,
      nodesSolved: metrics?.nodes_solved ?? null,
      nodesForfeited: metrics?.nodes_forfeited ?? null,
      nodesNegated: metrics?.nodes_negated ?? null,
    };
  }
  if (isRiverStrategy(strategy)) {
    return {
      ...common,
      // Which River variant ran — the GROUP BY key for the comparison.
      strategy,
      // Prefer the bridge's own observation of whether a seed was used
      // (river-delta generates its own), falling back to what we sent.
      nlSeedUsed: metrics?.nl_seed_used ?? nlSeedUsed ?? null,
      costDriverUsd: metrics?.cost_driver_usd ?? null,
      costSeedUsd: metrics?.cost_seed_usd ?? null,
      promptTokens: metrics?.prompt_tokens ?? null,
      completionTokens: metrics?.completion_tokens ?? null,
      cachedTokens: metrics?.cached_tokens ?? null,
      costCapHit: metrics?.cost_cap_hit ?? null,
      maxIters: metrics?.max_iters ?? null,
      blueprintIterations: metrics?.blueprint_iterations ?? null,
      nodesTotal: metrics?.nodes_total ?? null,
      nodesSolved: metrics?.nodes_solved ?? null,
      nodesForfeited: metrics?.nodes_forfeited ?? null,
      nodesNegated: metrics?.nodes_negated ?? null,
      deadEndsShared: metrics?.dead_ends_shared ?? null,
      deadEndsKnown: metrics?.dead_ends_known ?? null,
      // river-vintage watcher telemetry (absent on stone/gate/delta).
      interceptorNotes: metrics?.interceptor_notes ?? null,
      interceptorAborts: metrics?.interceptor_aborts ?? null,
      mechanicNotes: metrics?.mechanic_notes ?? null,
      consults: metrics?.consults ?? null,
    };
  }
  return {
    ...common,
    strategy,
    haveCaseCount: finalProof ? (finalProof.match(/\bhave\b/g) || []).length : null,
    checkpointUsed: !!seedUsed,
  };
}

/**
 * File the row. Returns the new row's id, or null if recording failed — callers
 * may ignore the result entirely (fire-and-forget) without risking an unhandled
 * rejection.
 */
export async function recordResearchRun(
  args: ResearchRunInput,
): Promise<string | null> {
  try {
    const res = await fetch(researchPathFor(args.strategy), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(researchBodyFor(args)),
      keepalive: true,
    });
    if (!res.ok) return null;
    const j = await res.json().catch(() => null);
    return typeof j?.id === 'string' ? j.id : null;
  } catch {
    /* research logging must never affect the verify loop */
    return null;
  }
}
