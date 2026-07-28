// The prover strategy catalogue — shared by the ACG pipeline (admin-pipeline)
// and the capability benchmark console so both offer the same families, label
// them identically, and file their research rows in the same tables.
//
// Three families, three research tables:
//   Stronghold — Claude CLI driver, single-agent or have-tree decomposition.
//   River      — Goedel-Architect blueprint pipeline, xAI Grok driver. Each
//                variant is an ablation of the one before it, so the table
//                isolates exactly one change at a time.
//   Ultra      — Stone's pipeline driven by the LOCAL Claude CLI instead.

export interface StrategyDef {
  value: string;
  label: string;
  note: string;
}

// Claude-driven strategies (single-agent, or have-tree decomposition).
export const STRONGHOLD_STRATEGIES: StrategyDef[] = [
  {
    value: 'hacker',
    label: 'Hacker (compiler-driven)',
    note: 'Single agent, iterating against the Lean compiler — submit, read the errors, patch, resubmit.',
  },
  {
    value: 'pantograph',
    label: 'Pantograph (interactive Leak II)',
    note: 'Single agent driving the interactive Pantograph tactic state rather than whole-file compiles.',
  },
  {
    value: 'librarian',
    label: 'Librarian (search-first control)',
    note: 'Search-first: establish which Mathlib lemmas exist before committing to a proof plan.',
  },
  {
    value: 'sketch',
    label: 'Sketch (plan then formalize)',
    note: 'Write an informal plan first, then formalize it step by step.',
  },
  {
    value: 'brute',
    label: 'Brute (automation only)',
    note: 'Automation tactics only — decide / norm_num / native_decide and friends.',
  },
  {
    value: 'have',
    label: 'Have (in-context, no top-level lemmas)',
    note: 'One agent, everything inside the proof as `have` steps; no top-level helper lemmas.',
  },
  {
    value: 'have-tree',
    label: 'Have-tree (isolated per-hole minions)',
    note: 'Planner writes a `have`-skeleton; each hole is filled by its own isolated minion; a finisher assembles. Resumable from a banked checkpoint.',
  },
];

// The Leak River variants — each an ablation of the previous one.
export const RIVER_STRATEGIES: StrategyDef[] = [
  {
    value: 'river-stone',
    label: 'Leak River Stone (control)',
    note: 'Control: the Goedel-Architect paper as written — blueprint → parallel isolated node provers → refinement. Nothing added.',
  },
  {
    value: 'river-gate',
    label: 'Leak River Gate (+ dead-end ledger)',
    note: 'Stone + a shared dead-end ledger: environment facts the compiler establishes on one node (names that do not exist, unavailable typeclasses, coercion traps) are pooled and handed to sibling nodes, so no two nodes independently rediscover the same wall. Proof strategy is never shared.',
  },
  {
    value: 'river-delta',
    label: 'Leak River Delta (+ Sonnet 5 NL seed)',
    note: 'Gate + one local Sonnet 5 call up front for a natural-language proof of the target, handed to blueprint generation as a structural guide (the paper’s §4.2 NL guidance). Refinement is deliberately left unseeded — it reasons from machine-checked diagnoses instead.',
  },
  {
    value: 'river-vintage',
    label: 'Leak River Vintage (+ oversight watchers)',
    note: 'Stone + the oversight watchers: a per-node interceptor (async semantic review of each prover’s own trajectory — note or abort, the node never waits) and a run-wide mechanic reading the full admin stream window in parallel, routing judgements to live agents, refinement, or the log. Nodes stay fully isolated — no proof strategy is ever shared between siblings.',
  },
];

// Leak Ultra — Stone's blueprint pipeline with the LOCAL Claude CLI as driver.
export const ULTRA_STRATEGIES: StrategyDef[] = [
  {
    value: 'ultra-fleeting',
    label: 'Leak Ultra Fleeting (Claude driver)',
    note: "Stone's pipeline — identical prompts, tool contract and gates — driven by the local Claude CLI instead of the xAI API, on the model selected above. The bridge serves lean_compile/mathlib_search to the CLI from a local MCP server so the compile gate stays bridge-side; cost is the CLI's own reported total_cost_usd, so no price table is involved.",
  },
];

export const isRiverStrategy = (s: string) =>
  s === 'architect' || s.startsWith('river-');
export const isUltraStrategy = (s: string) => s.startsWith('ultra-');
/** Both families run the architect orchestrator (and therefore Leak XI/XII/XIV). */
export const isArchitectStrategy = (s: string) =>
  isRiverStrategy(s) || isUltraStrategy(s);

// Which toolchain actually certifies a run. The architect group (Leak XI/XII/
// XIV) is a different, newer Lean than the Claude-driven group (Leak I/II/IV),
// so a row must never assume one.
export const TOOLCHAIN = 'leanprover/lean4:v4.29.1';
export const MATHLIB_VERSION = 'v4.29.1';
export const ARCHITECT_TOOLCHAIN = 'leanprover/lean4:v4.32.0';
export const ARCHITECT_MATHLIB_VERSION = 'v4.32.0';

// Human-readable "who enforced this" name for a certificate's Enforcer line.
const STRONGHOLD_ENFORCER_LABELS: Record<string, string> = {
  hacker: 'Leak Hacker',
  pantograph: 'Leak Pantograph',
  librarian: 'Leak Librarian',
  sketch: 'Leak Sketch',
  brute: 'Leak Brute',
  have: 'Leak Have',
  'have-tree': 'Leak Stronghold Dark',
};

export function enforcerLabelFor(strategy: string): string {
  const river = RIVER_STRATEGIES.find((s) => s.value === strategy);
  if (river) return river.label.split('(')[0].trim();
  const ultra = ULTRA_STRATEGIES.find((s) => s.value === strategy);
  if (ultra) return ultra.label.split('(')[0].trim();
  return STRONGHOLD_ENFORCER_LABELS[strategy] ?? 'Leak';
}

export function strategyLabel(strategy: string): string {
  return (
    [...RIVER_STRATEGIES, ...ULTRA_STRATEGIES, ...STRONGHOLD_STRATEGIES].find(
      (s) => s.value === strategy,
    )?.label ?? strategy
  );
}

export function strategyNote(strategy: string): string | null {
  return (
    [...RIVER_STRATEGIES, ...ULTRA_STRATEGIES, ...STRONGHOLD_STRATEGIES].find(
      (s) => s.value === strategy,
    )?.note ?? null
  );
}

// ── Benchmark budgets ───────────────────────────────────────────────────────
// A benchmark pass must be comparable across strategies and must terminate, so
// every architect run gets the same wall clock and the refinement budget is the
// only thing that varies. Vintage gets FEWER iterations on purpose: its
// per-attempt cutoff is divided by ARCHITECT_VINTAGE_CUTOFF_DIVISOR on the
// bridge, so it reaches refinement sooner and spends its clock differently —
// giving it the same iteration count would not make it a fair comparison, it
// would just let it run more refinements in the same time.
export const BENCHMARK_ARCHITECT_BUDGET_MS = 20 * 60_000;
export const BENCHMARK_VINTAGE_MAX_ITERS = 5;
export const BENCHMARK_ARCHITECT_MAX_ITERS = 8;
/** Non-architect decomposition (have-tree) keeps the ACG pipeline's own clock. */
export const BENCHMARK_TREE_BUDGET_MS = 30 * 60_000;

/**
 * The wall-clock + refinement budget one benchmark item gets under `strategy`.
 * `maxIters` is undefined for every non-architect strategy (they have no
 * refinement loop); `computeBudgetMs` is undefined for the single-agent path,
 * which the bridge runs uncapped.
 */
export function benchmarkBudgetFor(strategy: string): {
  computeBudgetMs?: number;
  maxIters?: number;
} {
  if (isArchitectStrategy(strategy)) {
    return {
      computeBudgetMs: BENCHMARK_ARCHITECT_BUDGET_MS,
      maxIters:
        strategy === 'river-vintage'
          ? BENCHMARK_VINTAGE_MAX_ITERS
          : BENCHMARK_ARCHITECT_MAX_ITERS,
    };
  }
  if (usesTreeEndpoint(strategy)) {
    return { computeBudgetMs: BENCHMARK_TREE_BUDGET_MS };
  }
  return {};
}

/**
 * Every NAMED strategy drives the bridge's `prove-tree` route; the empty string
 * means the plain single-agent `prove-stream` prover, which takes no strategy.
 */
export function usesTreeEndpoint(strategy: string): boolean {
  return !!strategy;
}

/** One-line summary of the budget a benchmark item gets, for the UI. */
export function budgetSummary(strategy: string): string {
  const { computeBudgetMs, maxIters } = benchmarkBudgetFor(strategy);
  if (!computeBudgetMs) return 'Uncapped — the single-agent prover runs to its own conclusion.';
  const mins = Math.round(computeBudgetMs / 60_000);
  return maxIters
    ? `${mins} min wall clock · ${maxIters} refinement iterations per problem.`
    : `${mins} min wall clock per problem.`;
}
