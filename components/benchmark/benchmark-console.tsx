'use client';

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Separator } from '@/components/ui/separator';
import { cn } from '@/lib/utils';
import {
  fetchProverMcpServers,
  type ProverMcpServer,
} from '@/lib/mcp/fetch-prover-servers';
import { runProverStream } from '@/lib/prover/run-prover-stream';
import { ProverConsole } from '@/components/prover/prover-console';
import type { ProverEvent, ProverOutcome } from '@/lib/prover/types';
import { LocalClaudeAgentManagement } from '@/components/local-claude-agent-management';
import { MCPServerManagement } from '@/components/mcp-server-management';
import {
  RIVER_STRATEGIES,
  STRONGHOLD_STRATEGIES,
  ULTRA_STRATEGIES,
  benchmarkBudgetFor,
  budgetSummary,
  isArchitectStrategy,
  strategyNote,
  usesTreeEndpoint,
} from '@/lib/prover/strategies';
import { recordResearchRun } from '@/lib/research/record-run';

// Models selectable for the local `claude` runs (Claude Max plan) — same list
// admin-pipeline.tsx offers for verification. Ignored by the River strategies,
// which are driven by the xAI API bridge-side.
const PROVER_MODELS: { value: string; label: string }[] = [
  { value: '', label: 'Default' },
  { value: 'claude-opus-4-8', label: 'Opus 4.8' },
  { value: 'claude-sonnet-5', label: 'Sonnet 5' },
  { value: 'claude-haiku-4-5-20251001', label: 'Haiku 4.5' },
  { value: 'claude-fable-5', label: 'Fable 5' },
];

// The full catalogue, grouped by family. '' is the plain single-agent prover
// (prove-stream, no strategy); every named strategy drives prove-tree.
const STRATEGY_GROUPS: { label: string; options: { value: string; label: string }[] }[] =
  [
    {
      label: 'Single agent',
      options: [{ value: '', label: 'Single-agent prover (no decomposition)' }],
    },
    { label: 'Leak Stronghold — Claude driver', options: STRONGHOLD_STRATEGIES },
    {
      label: 'Leak River — Goedel-Architect, grok driver',
      options: RIVER_STRATEGIES,
    },
    {
      label: 'Leak Ultra — Goedel-Architect, Claude CLI driver',
      options: ULTRA_STRATEGIES,
    },
  ];

// How many GENUINE attempts a problem gets before the loop gives up on it and
// moves on. See classifyFailure: quota/connectivity aborts don't count (the
// release hands the attempt back), so this only counts real failures on this
// specific problem.
const MAX_ATTEMPTS = 2;

// Detect Claude's usage/session-limit message so the loop pauses (never scores
// the current item) instead of mis-marking it a prover failure — same
// heuristic as admin-pipeline.tsx's detectSessionLimit.
function detectSessionLimit(text: string): boolean {
  const t = (text || '').trim();
  if (!/limit/i.test(t)) return false;
  return /(session|usage|rate)\s*limit|hit your|limit (reached|exceeded)/i.test(t);
}

// A failure is CATASTROPHIC when it says nothing about the problem — the bridge
// is down, the network dropped, the Claude Max quota is spent. Continuing would
// mark every remaining problem failed for reasons that have nothing to do with
// the prover, so the loop pauses and the claim is handed back unscored.
//
// Everything else is the problem's own fault (a statement that will not
// elaborate on our toolchain, a daemon that wedges on it, a malformed stream)
// and is SKIPPABLE: retried once, then set aside so the pass can finish.
function isCatastrophic(msg: string, streamText: string): boolean {
  if (detectSessionLimit(msg) || detectSessionLimit(streamText)) return true;
  return /failed to fetch|networkerror|load failed|econnrefused|ecconnreset|econnreset|enotfound|socket hang up|err_connection|bridge (is )?unreachable|fetch failed/i.test(
    msg,
  );
}

interface BenchmarkDefRow {
  id: string;
  label: string;
  blurb: string;
  note: string;
  total: number;
  sampleSizes: { label: string; value: number }[];
}

interface RunRow {
  id: string;
  benchmark: string;
  label: string;
  model: string | null;
  strategy: string | null;
  decompose: boolean;
  total: number;
  computeBudgetMs: number | null;
  maxIters: number | null;
  createdAt: string;
  pending: number;
  running: number;
  proved: number;
  refuted: number;
  unsolved: number;
  skipped: number;
  costUsd: number;
}

interface ItemRow {
  id: string;
  runId: string;
  problemId: string;
  statement: string;
  informal: string | null;
  status: string;
  proof: string | null;
  costUsd: number | null;
  refuted: boolean | null;
  counterexample: string | null;
  errorMessage: string | null;
  attempts: number;
  proofCheckpoint: string | null;
  proofCheckpointFilled: number | null;
  proofCheckpointTotal: number | null;
  metrics: Record<string, unknown> | null;
  researchRowId: string | null;
  startedAt: string | null;
  finishedAt: string | null;
}

function StatusDot({ status }: { status: string }) {
  const color =
    status === 'proved'
      ? 'bg-emerald-500'
      : status === 'refuted'
        ? 'bg-amber-500'
        : status === 'unsolved'
          ? 'bg-destructive'
          : status === 'skipped'
            ? 'bg-muted-foreground'
            : status === 'running'
              ? 'bg-sky-500 animate-pulse'
              : 'bg-muted-foreground/40';
  return <span className={cn('inline-block size-2 rounded-full', color)} />;
}

function ProgressBar({ run }: { run: RunRow }) {
  const done = run.proved + run.refuted + run.unsolved + run.skipped;
  const pct = run.total ? (done / run.total) * 100 : 0;
  const passPct = run.total ? (run.proved / run.total) * 100 : 0;
  // Pass rate over problems actually SCORED — skipped ones never got a verdict,
  // so counting them against the prover would understate it.
  const scored = run.proved + run.refuted + run.unsolved;
  const scoredPct = scored ? (run.proved / scored) * 100 : 0;
  return (
    <div className="space-y-1">
      <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
        <div className="h-full bg-emerald-500" style={{ width: `${passPct}%` }} />
        <div
          className="-mt-2 h-full bg-foreground/20"
          style={{ width: `${pct}%` }}
        />
      </div>
      <p className="font-mono text-xs text-muted-foreground">
        {done}/{run.total} attempted · {run.proved} proved (
        {scored ? scoredPct.toFixed(1) : '0.0'}% of {scored} scored) ·{' '}
        {run.refuted} refuted · {run.unsolved} unsolved
        {run.skipped ? ` · ${run.skipped} skipped` : ''} · $
        {run.costUsd.toFixed(2)} spent
      </p>
    </div>
  );
}

function fmtDuration(from: string | null, to: string | null): string {
  if (!from || !to) return '—';
  const s = Math.round((new Date(to).getTime() - new Date(from).getTime()) / 1000);
  if (!Number.isFinite(s) || s < 0) return '—';
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s`;
}

export function BenchmarkConsole() {
  const [runs, setRuns] = useState<RunRow[] | null>(null);
  const [benchmarks, setBenchmarks] = useState<BenchmarkDefRow[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [items, setItems] = useState<ItemRow[] | null>(null);
  const [creating, setCreating] = useState(false);
  const [label, setLabel] = useState('');
  const [benchmarkId, setBenchmarkId] = useState('');
  const [model, setModel] = useState('claude-opus-4-8');
  const [strategy, setStrategy] = useState('river-vintage');
  const [sampleSize, setSampleSize] = useState(0);
  const [expanded, setExpanded] = useState<string | null>(null);

  const [events, setEvents] = useState<ProverEvent[]>([]);
  const [running, setRunning] = useState(false);
  const [pauseMessage, setPauseMessage] = useState<string | null>(null);
  const [currentProblemId, setCurrentProblemId] = useState<string | null>(null);
  const stopRef = useRef(false);
  const abortRef = useRef<AbortController | null>(null);

  const loadRuns = useCallback(async () => {
    const res = await fetch('/api/admin/benchmark');
    if (!res.ok) return;
    const j = await res.json();
    setRuns(j.runs);
    if (Array.isArray(j.benchmarks)) {
      setBenchmarks(j.benchmarks);
      setBenchmarkId((cur) => cur || j.benchmarks[0]?.id || '');
    }
  }, []);

  const loadRun = useCallback(async (runId: string) => {
    const res = await fetch(`/api/admin/benchmark/${runId}`);
    if (res.ok) setItems((await res.json()).items);
  }, []);

  useEffect(() => {
    loadRuns();
  }, [loadRuns]);

  useEffect(() => {
    if (selected) loadRun(selected);
    else setItems(null);
  }, [selected, loadRun]);

  const selectedRun = runs?.find((r) => r.id === selected) || null;
  const activeBenchmark = benchmarks.find((b) => b.id === benchmarkId) || null;

  // Reset the sample size whenever the benchmark changes — its options differ.
  useEffect(() => {
    setSampleSize(0);
  }, [benchmarkId]);

  const budget = useMemo(() => benchmarkBudgetFor(strategy), [strategy]);

  const createRun = async () => {
    setCreating(true);
    try {
      const res = await fetch('/api/admin/benchmark', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          label:
            label.trim() ||
            `${activeBenchmark?.label ?? 'Leak'} — ${new Date().toLocaleString()}`,
          benchmark: benchmarkId,
          model,
          strategy: strategy || null,
          decompose: usesTreeEndpoint(strategy),
          limit: sampleSize || undefined,
          computeBudgetMs: budget.computeBudgetMs ?? null,
          maxIters: budget.maxIters ?? null,
        }),
      });
      if (res.ok) {
        const { run } = await res.json();
        setLabel('');
        await loadRuns();
        setSelected(run.id);
      }
    } finally {
      setCreating(false);
    }
  };

  const deleteRun = async (runId: string) => {
    await fetch(`/api/admin/benchmark/${runId}`, { method: 'DELETE' });
    if (selected === runId) setSelected(null);
    await loadRuns();
  };

  const patchItem = useCallback(
    async (runId: string, body: Record<string, unknown>) => {
      await fetch(`/api/admin/benchmark/${runId}/item`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }).catch(() => {});
    },
    [],
  );

  const requeue = useCallback(
    async (runId: string, body: Record<string, unknown>) => {
      await fetch(`/api/admin/benchmark/${runId}/requeue`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }).catch(() => {});
      await loadRun(runId);
      await loadRuns();
    },
    [loadRun, loadRuns],
  );

  // The resumable loop: claim the next pending problem, prove it on the
  // admin's connected bridge, persist the outcome AND a research row, repeat.
  //
  // Failures are triaged (see isCatastrophic): a quota/connectivity failure
  // pauses the whole loop and hands the claim back unscored, so a flat battery
  // never scores 60 problems as misses. A failure specific to this problem is
  // retried once and then SKIPPED, so one pathological statement cannot stall
  // an overnight pass.
  const runLoop = useCallback(async () => {
    if (!selected) return;
    const run = runs?.find((r) => r.id === selected);
    if (!run) return;
    const runStrategy = run.strategy || '';
    const runModel = run.model || '';
    const tree = usesTreeEndpoint(runStrategy);
    const runBudget = {
      computeBudgetMs: run.computeBudgetMs ?? undefined,
      maxIters: run.maxIters ?? undefined,
    };

    stopRef.current = false;
    setRunning(true);
    setPauseMessage(null);
    try {
      const mcpServers: ProverMcpServer[] = await fetchProverMcpServers();
      while (!stopRef.current) {
        const claimRes = await fetch(`/api/admin/benchmark/${selected}/claim`, {
          method: 'POST',
        });
        if (!claimRes.ok) {
          setPauseMessage('Could not reach the benchmark API — paused.');
          break;
        }
        const { item } = (await claimRes.json()) as { item: ItemRow | null };
        if (!item) {
          setPauseMessage(null);
          break; // run complete
        }
        setCurrentProblemId(item.problemId);
        setEvents([]);
        let content = '';
        let metrics: ProverOutcome['metrics'];
        const ctrl = new AbortController();
        abortRef.current = ctrl;

        // Safety net, NOT a cap on the prover: the bridge owns the run's real
        // deadline (runBudget.computeBudgetMs, which the operator chose). This
        // only fires well past it, when the stream has wedged and the bridge
        // has failed to honour its own budget — otherwise one hung socket
        // would stall the pass indefinitely.
        const watchdogMs = runBudget.computeBudgetMs
          ? runBudget.computeBudgetMs + 5 * 60_000
          : 0;
        const watchdog = watchdogMs
          ? setTimeout(() => ctrl.abort(), watchdogMs)
          : null;

        try {
          const outcome: ProverOutcome = await runProverStream({
            problem: item.statement,
            mcpServers,
            model: runModel || undefined,
            signal: ctrl.signal,
            onEvent: (ev) => {
              setEvents((prev) => [...prev, ev]);
              content += ` ${ev.label || ''} ${ev.detail || ''}`;
              if (ev.metrics) metrics = ev.metrics;
            },
            source: `benchmark:${run.benchmark}:${item.problemId}`,
            endpoint: tree ? 'prove-tree' : 'prove-stream',
            strategy: tree ? runStrategy : undefined,
            computeBudgetMs: runBudget.computeBudgetMs,
            maxIters: isArchitectStrategy(runStrategy)
              ? runBudget.maxIters
              : undefined,
            seed: item.proofCheckpoint || undefined,
            onCheckpoint: ({ skeleton, filled, total }) => {
              patchItem(selected, {
                action: 'checkpoint',
                itemId: item.id,
                skeleton,
                filled,
                total,
              });
            },
          });
          const finalMetrics = outcome.metrics ?? metrics;

          // Research row FIRST so its id can be stored on the item — one row
          // per attempt, in the same table the ACG pipeline files into, so
          // benchmark runs and pipeline runs are directly comparable.
          const researchRowId = await recordResearchRun({
            problemTitle: item.problemId,
            sorriedTheorem: item.statement,
            strategy: runStrategy || 'single-agent',
            model: runModel,
            verified: !!outcome.verified,
            refuted: !!outcome.refuted,
            costUsd: outcome.costUsd,
            computeBudgetMs: runBudget.computeBudgetMs,
            metrics: finalMetrics,
            finalProof: outcome.proof || '',
            error: null,
            notes: `benchmark:${run.benchmark}:${selected}`,
          });

          await patchItem(selected, {
            action: 'outcome',
            itemId: item.id,
            status: outcome.refuted
              ? 'refuted'
              : outcome.verified
                ? 'proved'
                : 'unsolved',
            proof: outcome.proof,
            costUsd: outcome.costUsd,
            refuted: !!outcome.refuted,
            counterexample: outcome.counterexample,
            metrics: finalMetrics ?? null,
            researchRowId,
          });
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          // Operator pressed Pause: never score, never count the attempt.
          if (stopRef.current) {
            await patchItem(selected, { action: 'release', itemId: item.id });
            setPauseMessage(
              `Paused on ${item.problemId} — progress saved, nothing scored. Click Resume to continue.`,
            );
            break;
          }
          if (isCatastrophic(msg, content)) {
            await patchItem(selected, { action: 'release', itemId: item.id });
            setPauseMessage(
              detectSessionLimit(content) || detectSessionLimit(msg)
                ? `Claude Max session limit hit while proving ${item.problemId} — paused. Progress is saved and this problem was not scored; click Resume once your limit resets.`
                : `Bridge/connectivity failure on ${item.problemId} — paused, nothing scored. ${msg.slice(0, 160)}`,
            );
            break;
          }
          // Specific to this problem: retry until MAX_ATTEMPTS genuine tries,
          // then set it aside and carry on. `retry` (not `release`) keeps the
          // attempt count, which is what makes this terminate.
          if (item.attempts >= MAX_ATTEMPTS) {
            await patchItem(selected, {
              action: 'skip',
              itemId: item.id,
              reason: `Skipped after ${item.attempts} failed attempts: ${msg.slice(0, 400)}`,
            });
          } else {
            await patchItem(selected, { action: 'retry', itemId: item.id });
          }
        } finally {
          if (watchdog) clearTimeout(watchdog);
        }
        await loadRuns();
      }
    } finally {
      setRunning(false);
      setCurrentProblemId(null);
      if (selected) {
        loadRun(selected);
        loadRuns();
      }
    }
  }, [selected, runs, loadRuns, loadRun, patchItem]);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-2">
        <LocalClaudeAgentManagement />
        <MCPServerManagement />
      </div>

      <div className="rounded-lg border p-4">
        <h2 className="text-sm font-semibold">New benchmark run</h2>
        <p className="mt-1 text-xs text-muted-foreground">
          Runs on your connected bridge, one problem at a time, fully resumable —
          a usage limit or a closed laptop pauses the pass without scoring
          anything. Every attempt files a research row and stores its proof.
        </p>
        <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <div className="lg:col-span-2">
            <Label className="text-xs">Benchmark</Label>
            <select
              value={benchmarkId}
              onChange={(e) => setBenchmarkId(e.target.value)}
              className="mt-1 h-8 w-full rounded-md border bg-background px-2 text-sm"
            >
              {benchmarks.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.label}
                </option>
              ))}
            </select>
          </div>
          <div>
            <Label className="text-xs">Sample size</Label>
            <select
              value={sampleSize}
              onChange={(e) => setSampleSize(Number(e.target.value))}
              className="mt-1 h-8 w-full rounded-md border bg-background px-2 text-sm"
            >
              {(activeBenchmark?.sampleSizes ?? []).map((s) => (
                <option key={s.value} value={s.value}>
                  {s.label}
                </option>
              ))}
            </select>
          </div>
          <div>
            <Label className="text-xs">Label</Label>
            <Input
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="Vintage baseline"
              className="mt-1 h-8 text-sm"
            />
          </div>
          <div>
            <Label className="text-xs">Strategy</Label>
            <select
              value={strategy}
              onChange={(e) => setStrategy(e.target.value)}
              className="mt-1 h-8 w-full rounded-md border bg-background px-2 text-sm"
            >
              {STRATEGY_GROUPS.map((g) => (
                <optgroup key={g.label} label={g.label}>
                  {g.options.map((s) => (
                    <option key={s.value || 'single'} value={s.value}>
                      {s.label}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
          </div>
          <div>
            <Label className="text-xs">
              Model{' '}
              <span className="font-normal text-muted-foreground">
                (Claude-driven strategies only)
              </span>
            </Label>
            <select
              value={model}
              onChange={(e) => setModel(e.target.value)}
              className="mt-1 h-8 w-full rounded-md border bg-background px-2 text-sm"
            >
              {PROVER_MODELS.map((m) => (
                <option key={m.value} value={m.value}>
                  {m.label}
                </option>
              ))}
            </select>
          </div>
        </div>

        {activeBenchmark && (
          <p className="mt-3 text-xs text-muted-foreground">
            <span className="font-medium text-foreground">
              {activeBenchmark.total} problems.
            </span>{' '}
            {activeBenchmark.note}
          </p>
        )}
        <p className="mt-2 text-xs text-muted-foreground">
          <span className="font-medium text-foreground">Budget:</span>{' '}
          {budgetSummary(strategy)}{' '}
          {strategyNote(strategy) ? (
            <span className="opacity-80">{strategyNote(strategy)}</span>
          ) : null}
        </p>

        <Button size="sm" className="mt-3" disabled={creating} onClick={createRun}>
          {creating ? 'Creating…' : 'Create run'}
        </Button>
      </div>

      <div className="space-y-2">
        <h2 className="text-sm font-semibold">Runs</h2>
        {!runs?.length && (
          <p className="text-xs text-muted-foreground">
            No benchmark runs yet — create one above.
          </p>
        )}
        <div className="space-y-2">
          {runs?.map((r) => (
            <button
              key={r.id}
              type="button"
              onClick={() => setSelected(r.id)}
              className={cn(
                'block w-full rounded-lg border p-3 text-left transition-colors hover:bg-muted/50',
                selected === r.id && 'border-foreground/40 bg-muted/30',
              )}
            >
              <div className="flex items-center justify-between gap-2">
                <span className="text-sm font-medium">{r.label}</span>
                <span className="font-mono text-[11px] text-muted-foreground">
                  {r.benchmark} · {r.strategy || 'single-agent'}
                  {r.maxIters ? ` · ${r.maxIters} iters` : ''}
                  {r.computeBudgetMs
                    ? ` · ${Math.round(r.computeBudgetMs / 60000)}m`
                    : ''}
                </span>
              </div>
              <div className="mt-2">
                <ProgressBar run={r} />
              </div>
            </button>
          ))}
        </div>
      </div>

      {selectedRun && (
        <div className="space-y-3 rounded-lg border p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="text-sm font-semibold">{selectedRun.label}</h3>
            <div className="flex flex-wrap items-center gap-2">
              {!running ? (
                <Button size="sm" onClick={runLoop}>
                  {selectedRun.proved +
                    selectedRun.refuted +
                    selectedRun.unsolved +
                    selectedRun.skipped >
                  0
                    ? 'Resume'
                    : 'Start'}
                </Button>
              ) : (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    // Stop claiming new items AND abort whatever's in flight —
                    // a proof can run for its full budget, so without the abort
                    // this button would do nothing until the attempt finished.
                    stopRef.current = true;
                    abortRef.current?.abort();
                  }}
                >
                  Pause
                </Button>
              )}
              {!!selectedRun.skipped && (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={running}
                  onClick={() => requeue(selectedRun.id, { statuses: ['skipped'] })}
                >
                  Retry {selectedRun.skipped} skipped
                </Button>
              )}
              {!!selectedRun.unsolved && (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={running}
                  onClick={() => requeue(selectedRun.id, { statuses: ['unsolved'] })}
                >
                  Retry {selectedRun.unsolved} unsolved
                </Button>
              )}
              <Button
                size="sm"
                variant="ghost"
                className="text-destructive"
                disabled={running}
                onClick={() => deleteRun(selectedRun.id)}
              >
                Delete
              </Button>
            </div>
          </div>
          <ProgressBar run={selectedRun} />
          {pauseMessage && (
            <p className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-400">
              {pauseMessage}
            </p>
          )}

          <ProverConsole
            events={events}
            running={running}
            title={
              currentProblemId ? `Proving ${currentProblemId}` : 'Prover activity'
            }
            emptyHint="Click Start/Resume to begin proving pending problems."
          />

          <Separator />

          <div className="max-h-[32rem] overflow-y-auto rounded-md border">
            <table className="w-full text-xs">
              <thead className="sticky top-0 bg-muted/80 backdrop-blur">
                <tr className="text-left">
                  <th className="px-2 py-1.5 font-medium">Problem</th>
                  <th className="px-2 py-1.5 font-medium">Status</th>
                  <th className="px-2 py-1.5 font-medium">Cost</th>
                  <th className="px-2 py-1.5 font-medium">Time</th>
                  <th className="px-2 py-1.5 font-medium">Tries</th>
                  <th className="px-2 py-1.5 font-medium">Actions</th>
                </tr>
              </thead>
              <tbody>
                {items?.map((it) => (
                  <Fragment key={it.id}>
                    <tr className="border-t">
                      <td className="px-2 py-1 font-mono">
                        <button
                          type="button"
                          className="underline-offset-2 hover:underline"
                          onClick={() =>
                            setExpanded(expanded === it.id ? null : it.id)
                          }
                        >
                          {it.problemId}
                        </button>
                      </td>
                      <td className="px-2 py-1">
                        <span className="inline-flex items-center gap-1.5">
                          <StatusDot status={it.status} />
                          {it.status}
                        </span>
                      </td>
                      <td className="px-2 py-1 font-mono">
                        {it.costUsd != null ? `$${it.costUsd.toFixed(3)}` : '—'}
                      </td>
                      <td className="px-2 py-1 font-mono">
                        {fmtDuration(it.startedAt, it.finishedAt)}
                      </td>
                      <td className="px-2 py-1">{it.attempts}</td>
                      <td className="px-2 py-1">
                        <div className="flex gap-1">
                          {it.status !== 'pending' && it.status !== 'running' && (
                            <button
                              type="button"
                              disabled={running}
                              className="text-[11px] text-sky-600 underline-offset-2 hover:underline disabled:opacity-40"
                              onClick={async () => {
                                await patchItem(selectedRun.id, {
                                  action: 'requeue',
                                  itemId: it.id,
                                });
                                await loadRun(selectedRun.id);
                                await loadRuns();
                              }}
                            >
                              retry
                            </button>
                          )}
                          {it.status !== 'pending' && it.status !== 'running' && (
                            <button
                              type="button"
                              disabled={running}
                              className="text-[11px] text-amber-600 underline-offset-2 hover:underline disabled:opacity-40"
                              title="Clear this item's banked checkpoint and attempt count, then retry — use when a resumed attempt keeps skipping straight to single-context mode instead of running the selected strategy for real"
                              onClick={async () => {
                                if (
                                  !window.confirm(
                                    `Retry "${it.problemId}" completely fresh? This clears its saved checkpoint and attempt count — only this problem is affected, everything else in the run stays as-is.`,
                                  )
                                )
                                  return;
                                await patchItem(selectedRun.id, {
                                  action: 'reset_fresh',
                                  itemId: it.id,
                                });
                                await loadRun(selectedRun.id);
                                await loadRuns();
                              }}
                            >
                              fresh
                            </button>
                          )}
                          <button
                            type="button"
                            disabled={running}
                            className="text-[11px] text-muted-foreground underline-offset-2 hover:underline disabled:opacity-40"
                            title="Requeue this problem and every one after it"
                            onClick={() =>
                              requeue(selectedRun.id, { from: it.problemId })
                            }
                          >
                            from here
                          </button>
                        </div>
                      </td>
                    </tr>
                    {expanded === it.id && (
                      <tr className="border-t bg-muted/30">
                        <td colSpan={6} className="px-3 py-2">
                          {it.informal && (
                            <p className="mb-2 text-[11px] italic text-muted-foreground">
                              {it.informal}
                            </p>
                          )}
                          <p className="mb-1 text-[11px] font-medium">Statement</p>
                          <pre className="mb-2 max-h-40 overflow-auto whitespace-pre-wrap rounded border bg-background p-2 font-mono text-[11px]">
                            {it.statement}
                          </pre>
                          {it.proof && (
                            <>
                              <p className="mb-1 text-[11px] font-medium">
                                Proof{' '}
                                <button
                                  type="button"
                                  className="ml-1 font-normal text-sky-600 underline-offset-2 hover:underline"
                                  onClick={() =>
                                    navigator.clipboard?.writeText(it.proof || '')
                                  }
                                >
                                  copy
                                </button>
                              </p>
                              <pre className="mb-2 max-h-64 overflow-auto whitespace-pre-wrap rounded border bg-background p-2 font-mono text-[11px]">
                                {it.proof}
                              </pre>
                            </>
                          )}
                          {it.counterexample && (
                            <>
                              <p className="mb-1 text-[11px] font-medium">
                                Counterexample
                              </p>
                              <pre className="mb-2 max-h-40 overflow-auto whitespace-pre-wrap rounded border bg-background p-2 font-mono text-[11px]">
                                {it.counterexample}
                              </pre>
                            </>
                          )}
                          {it.errorMessage && (
                            <p className="text-[11px] text-destructive">
                              {it.errorMessage}
                            </p>
                          )}
                          {it.researchRowId && (
                            <p className="mt-1 font-mono text-[10px] text-muted-foreground">
                              research row {it.researchRowId}
                            </p>
                          )}
                        </td>
                      </tr>
                    )}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
