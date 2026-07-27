'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Loader2,
  Play,
  ShieldCheck,
  ShieldAlert,
  GitBranch,
  Square,
} from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { fetchProverMcpServers } from '@/lib/mcp/fetch-prover-servers';
import {
  runProverStream,
  extendProverRun,
} from '@/lib/prover/run-prover-stream';
import { ProverConsole } from '@/components/prover/prover-console';
import type { ProverEvent, ProverOutcome } from '@/lib/prover/types';

// Wall-clock budget for a decomposition (tree) run — matches the admin verifier
// (VERIFY_COMPUTE_BUDGET_MS) so the playground behaves identically. The tree path
// governs by TIME when this is set and reports a runId so "+5 min" can push it
// out; the single-agent path ignores it. Never a cap on the prover otherwise.
const PLAYGROUND_COMPUTE_BUDGET_MS = 30 * 60_000;
// The architect strategy is governed much tighter — fail fast/cheap while
// it's under test — and extends one minute at a time instead of five.
const ARCHITECT_COMPUTE_BUDGET_MS = 5 * 60_000;
const ARCHITECT_EXTEND_MS = 1 * 60_000;
// Grok is the only driver proveArchitect supports — lock the model selector
// to this value whenever a Leak River strategy is active.
const ARCHITECT_MODEL = 'grok-4-1-fast-reasoning';
const ARCHITECT_DEFAULT_ITERS = 5;
const isRiverStrategy = (s: string) =>
  s === 'architect' || s.startsWith('river-');

// A minimal "message the prover" surface. It reuses the exact same runner +
// console as the admin queue resolver — send a statement, watch every step,
// extend the compute budget live, or terminate — full parity with the verifier.
export function ProverPlayground() {
  const [problem, setProblem] = useState(
    'theorem sample : 1 + 1 = 2 := by sorry',
  );
  const [events, setEvents] = useState<ProverEvent[]>([]);
  const [running, setRunning] = useState(false);
  const [outcome, setOutcome] = useState<ProverOutcome | null>(null);
  // Decomposition mode drives the /prove-tree orchestrator: prove-or-split, so a
  // stalled goal is broken into verified sub-lemmas instead of looping forever.
  const [decompose, setDecompose] = useState(false);
  // Strategy mode for A/B testing proof approaches (tree path only).
  const [strategy, setStrategy] = useState('hacker');
  // Model the prover runs on ('' = the bridge/CLI default).
  const [model, setModel] = useState('');
  // Architect strategy always drives Grok directly — force + lock the model.
  useEffect(() => {
    if (isRiverStrategy(strategy)) setModel(ARCHITECT_MODEL);
    else setModel((m) => (m === ARCHITECT_MODEL ? '' : m));
  }, [strategy]);
  // Refinement-iteration budget for Leak River runs (+1 per click).
  const [maxIters, setMaxIters] = useState(ARCHITECT_DEFAULT_ITERS);

  // Live compute-budget state for the tree path: the bridge reports a runId +
  // deadline via onRunId; the "+5 min" button (extend) pushes the deadline out.
  const [computeLimit, setComputeLimit] = useState<{
    deadlineMs: number;
    budgetMs: number;
  } | null>(null);
  const [extending, setExtending] = useState(false);
  const [extendingIters, setExtendingIters] = useState(false);
  const runIdRef = useRef<string | null>(null);
  // Latest saved checkpoint (a partially-filled skeleton) from a decompose run.
  // Persists in component state so you can Resume after a Terminate or a stop.
  const [checkpoint, setCheckpoint] = useState<{
    skeleton: string;
    filled: number;
    total: number;
  } | null>(null);
  // Lets the Terminate button abort a running prove; aborting the fetch trips the
  // bridge's disconnect handler, which kills the claude run server-side.
  const abortRef = useRef<AbortController | null>(null);

  const run = useCallback(
    async (seed?: string) => {
      if (!problem.trim()) return;
      // Resuming is always a tree run (the seed is a have-tree skeleton).
      const asTree = decompose || !!seed;
      setRunning(true);
      setEvents([]);
      setOutcome(null);
      setComputeLimit(null);
      runIdRef.current = null;
      const ctrl = new AbortController();
      abortRef.current = ctrl;
      const append = (e: ProverEvent) => setEvents((prev) => [...prev, e]);
      try {
        const mcpServers = await fetchProverMcpServers();
        const out = await runProverStream({
          problem,
          mcpServers,
          model: model || undefined,
          signal: ctrl.signal,
          onEvent: append,
          source: asTree ? `playground-tree:${strategy}` : 'playground',
          endpoint: asTree ? 'prove-tree' : 'prove-stream',
          strategy: asTree ? strategy : undefined,
          seed,
          // Tree path runs under an extendable wall-clock budget; the single-agent
          // path ignores it (and never fires onRunId), so no indicator shows.
          // Architect gets a much tighter budget (see ARCHITECT_COMPUTE_BUDGET_MS).
          computeBudgetMs: asTree
            ? isRiverStrategy(strategy)
              ? ARCHITECT_COMPUTE_BUDGET_MS
              : PLAYGROUND_COMPUTE_BUDGET_MS
            : undefined,
          maxIters: isRiverStrategy(strategy) ? maxIters : undefined,
          onRunId: ({ runId, deadlineMs, budgetMs }) => {
            runIdRef.current = runId;
            setComputeLimit({ deadlineMs, budgetMs });
          },
          // Auto-save the latest banked checkpoint so a stop/Terminate can Resume.
          onCheckpoint: (cp) => setCheckpoint(cp),
        });
        setOutcome(out);
      } catch {
        /* the console already shows the error event (or the abort) */
      } finally {
        setRunning(false);
        runIdRef.current = null;
        abortRef.current = null;
      }
    },
    [problem, decompose, strategy, model, maxIters],
  );

  // Push the running prove's wall-clock budget out. Best-effort.
  const extend = useCallback(async () => {
    const runId = runIdRef.current;
    if (!runId || extending) return;
    setExtending(true);
    try {
      const addMs = isRiverStrategy(strategy) ? ARCHITECT_EXTEND_MS : 5 * 60_000;
      const r = await extendProverRun({ runId, addMs });
      if (r) setComputeLimit(r);
    } finally {
      setExtending(false);
    }
  }, [extending, strategy]);

  // "+1 iter": raise the refinement budget for the NEXT run and, while a River
  // run is live, for that run too (the bridge re-reads the budget each iteration).
  const extendIters = useCallback(async () => {
    if (extendingIters) return;
    setExtendingIters(true);
    try {
      setMaxIters((n) => Math.min(32, n + 1));
      const runId = runIdRef.current;
      if (!runId) return;
      const r = await extendProverRun({ runId, addIters: 1 });
      if (r?.maxIters) setMaxIters(r.maxIters);
    } finally {
      setExtendingIters(false);
    }
  }, [extendingIters]);

  const terminate = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  return (
    <div className="space-y-4">
      <Textarea
        value={problem}
        onChange={(e) => setProblem(e.target.value)}
        rows={4}
        className="font-mono text-sm"
        placeholder="Enter a statement (Lean theorem, or a problem to prove)…"
      />
      <div className="flex flex-wrap items-center gap-3">
        <Button onClick={() => run()} disabled={running || !problem.trim()} className="gap-2">
          {running ? (
            <Loader2 className="size-4 animate-spin" />
          ) : (
            <Play className="size-4" />
          )}
          Send to prover
        </Button>
        {!running && checkpoint && (
          <button
            type="button"
            onClick={() => run(checkpoint.skeleton)}
            className="inline-flex items-center gap-1.5 rounded-md border border-violet-500/50 bg-violet-500/10 px-3 py-1.5 text-sm text-violet-600 transition-colors hover:bg-violet-500/20 dark:text-violet-400"
            title="Continue from the saved checkpoint instead of restarting"
          >
            <GitBranch className="size-3.5" />
            Resume ({checkpoint.filled}/{checkpoint.total})
          </button>
        )}
        {running && (
          <button
            type="button"
            onClick={terminate}
            className="inline-flex items-center gap-1.5 rounded-md border border-rose-500/50 bg-rose-500/10 px-3 py-1.5 text-sm text-rose-600 transition-colors hover:bg-rose-500/20 dark:text-rose-400"
            title="Stop this prove — kills the claude run server-side via the bridge"
          >
            <Square className="size-3.5" />
            Terminate
          </button>
        )}
        <button
          type="button"
          onClick={() => setDecompose((v) => !v)}
          disabled={running}
          className={`inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-sm transition-colors ${
            decompose
              ? 'border-violet-500/50 bg-violet-500/10 text-violet-600 dark:text-violet-400'
              : 'text-muted-foreground hover:bg-muted'
          }`}
          title="Break the goal into verified sub-lemmas recursively (prove-or-split tree)"
        >
          <GitBranch className="size-3.5" />
          Decompose mode {decompose ? 'on' : 'off'}
        </button>
        <label className="inline-flex items-center gap-1.5 text-sm text-muted-foreground">
          Model
          <select
            value={isRiverStrategy(strategy) ? ARCHITECT_MODEL : model}
            onChange={(e) => setModel(e.target.value)}
            disabled={running || isRiverStrategy(strategy)}
            className="rounded-md border bg-background px-2 py-1.5 text-sm disabled:opacity-60"
            title={
              isRiverStrategy(strategy)
                ? 'Leak River strategies always drive Grok directly — model is locked.'
                : undefined
            }
          >
            {isRiverStrategy(strategy) ? (
              <option value={ARCHITECT_MODEL}>
                Grok 4.1 Fast Reasoning (forced)
              </option>
            ) : (
              <>
                <option value="">Default</option>
                <option value="claude-opus-4-8">Opus 4.8</option>
                <option value="claude-sonnet-5">Sonnet 5</option>
                <option value="claude-fable-5">Fable 5</option>
                <option value="claude-haiku-4-5-20251001">Haiku 4.5</option>
              </>
            )}
          </select>
        </label>
        {decompose && (
          <label className="inline-flex items-center gap-1.5 text-sm text-muted-foreground">
            Strategy
            <select
              value={strategy}
              onChange={(e) => setStrategy(e.target.value)}
              disabled={running}
              className="rounded-md border bg-background px-2 py-1.5 text-sm"
            >
              <option value="hacker">Hacker (compiler-driven)</option>
              <option value="pantograph">Pantograph (interactive Leak II)</option>
              <option value="librarian">Librarian (search-first control)</option>
              <option value="sketch">Sketch (plan then formalize)</option>
              <option value="brute">Brute (automation only)</option>
              <option value="have">Have (in-context, no top-level lemmas)</option>
              <option value="have-tree">Have-tree (isolated per-hole minions · linear context)</option>
              <optgroup label="Leak River (Goedel blueprint · grok driver)">
                <option value="river-stone">Leak River Stone (control)</option>
                <option value="river-gate">Leak River Gate (+ dead-end ledger)</option>
                <option value="river-delta">Leak River Delta (+ Sonnet 5 NL seed)</option>
              </optgroup>
            </select>
          </label>
        )}
        {/* The refinement-budget control lives on the console below, alongside the
            clock control, so it can be raised MID-FLIGHT and not just per run. */}
      </div>
      {decompose && (
        <p className="text-xs text-muted-foreground">
          Prove-or-split: each goal gets a bounded direct attempt, then is broken
          into toolchain-verified sub-lemmas (recursively) and assembled into one
          sorry-free proof.{' '}
          {strategy === 'pantograph'
            ? 'Pantograph mode builds proofs interactively in Leak II; Leak IV is used only as the final guardrail.'
            : 'Hacker mode leads with the compiler (verify_full_script) and strong automation.'}{' '}
          Needs a verify_full_script MCP server connected. Runs under a{' '}
          {Math.round(
            (isRiverStrategy(strategy)
              ? ARCHITECT_COMPUTE_BUDGET_MS
              : PLAYGROUND_COMPUTE_BUDGET_MS) / 60_000,
          )}
          -minute compute budget you can extend live (+
          {Math.round(
            (isRiverStrategy(strategy) ? ARCHITECT_EXTEND_MS : 5 * 60_000) /
              60_000,
          )}{' '}
          min)
          {isRiverStrategy(strategy)
            ? `, with ${maxIters} refinement iteration(s) — raise either live from the console header`
            : ''}
          .
        </p>
      )}

      <ProverConsole
        events={events}
        running={running}
        computeLimit={computeLimit}
        onExtend={extend}
        extending={extending}
        extendLabel={isRiverStrategy(strategy) ? '1 min' : '5 min'}
        iterLimit={
          decompose && isRiverStrategy(strategy) ? { budget: maxIters } : null
        }
        onExtendIters={extendIters}
        extendingIters={extendingIters}
        onResetIters={
          maxIters === ARCHITECT_DEFAULT_ITERS
            ? undefined
            : () => setMaxIters(ARCHITECT_DEFAULT_ITERS)
        }
      />

      {outcome && (
        <div
          className={`flex items-start gap-2 rounded-lg border p-4 ${
            outcome.verified
              ? 'border-emerald-500/40 bg-emerald-500/10'
              : 'border-amber-500/40 bg-amber-500/10'
          }`}
        >
          {outcome.verified ? (
            <ShieldCheck className="mt-0.5 size-4 text-emerald-500" />
          ) : (
            <ShieldAlert className="mt-0.5 size-4 text-amber-500" />
          )}
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium">
              {outcome.verified
                ? 'Verified by your MCP server'
                : 'Not verified'}
            </p>
            {outcome.proof && (
              <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap rounded bg-background/60 p-3 font-mono text-xs">
                {outcome.proof}
              </pre>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
