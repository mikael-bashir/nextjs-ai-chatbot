'use client';

import {
  Fragment,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from 'react';
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

// Upper bound on parallel workers. Each worker is a full prover attempt on the
// shared bridge (its own claude processes, its own Leak IV verifies), so the
// cap is where the bridge and the Claude Max quota stay comfortable — not
// where the queue math breaks: claims are row-locked server-side
// (FOR UPDATE SKIP LOCKED), so any worker count is race-free.
const MAX_PARALLEL = 4;

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

interface PoolProblem {
  id: string;
  statement: string;
  informal: string | null;
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

// One parallel worker's console state, keyed by slot index. Kept after the
// pass ends so the last log of each worker stays readable.
interface WorkerSlot {
  problemId: string | null;
  events: ProverEvent[];
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

// The attempt's real duration is the prover's own measured `time_elapsed`
// (seconds) — NOT finished_at − started_at, which is DB wall-clock and can be
// wildly wrong for a resumed/requeued item (finished_at gets rewritten by
// requeue while started_at stays at the original claim, yielding day-long
// bogus values). Prefer the metric; fall back to wall-clock only when absent.
function fmtAttemptTime(it: BenchmarkItemRow): string {
  const te = it.metrics?.time_elapsed;
  if (typeof te === 'number' && Number.isFinite(te) && te >= 0) {
    const s = Math.round(te);
    return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s`;
  }
  return fmtDuration(it.startedAt, it.finishedAt);
}

// The "add exactly the problems you want" picker — ACG-style click-to-add
// (no drag-and-drop library needed; ACG's own queue is click-based too, see
// admin-pipeline.tsx's enqueueVerify). Pool is whatever the SELECTED run's
// benchmark is; already-queued problems are hidden so re-picking one is a
// visible no-op rather than a silent duplicate.
function PoolPicker({
  pool,
  loading,
  queuedIds,
  picked,
  setPicked,
  filter,
  setFilter,
  adding,
  onAddOne,
  onAddMany,
}: {
  pool: PoolProblem[] | null;
  loading: boolean;
  queuedIds: Set<string>;
  picked: Set<string>;
  setPicked: Dispatch<SetStateAction<Set<string>>>;
  filter: string;
  setFilter: (v: string) => void;
  adding: boolean;
  onAddOne: (id: string) => void;
  onAddMany: (ids: string[]) => void;
}) {
  const available = (pool ?? []).filter((p) => !queuedIds.has(p.id));
  const q = filter.trim().toLowerCase();
  const visible = q
    ? available.filter(
        (p) =>
          p.id.toLowerCase().includes(q) ||
          (p.informal ?? '').toLowerCase().includes(q),
      )
    : available;

  const toggle = (id: string) =>
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <div className="space-y-2 rounded-md border p-3">
      <div className="flex flex-wrap items-center gap-2">
        <Input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Filter by id or text…"
          className="h-8 max-w-xs text-sm"
        />
        <span className="text-xs text-muted-foreground">
          {loading
            ? 'Loading pool…'
            : `${visible.length} available${filter ? ` (of ${available.length} unqueued)` : ''}`}
        </span>
        <div className="ml-auto flex items-center gap-2">
          <Button
            size="sm"
            variant="outline"
            disabled={adding || !visible.length}
            onClick={() => onAddMany(visible.map((p) => p.id))}
          >
            Add all {visible.length}
          </Button>
          <Button
            size="sm"
            disabled={adding || !picked.size}
            onClick={() => onAddMany([...picked])}
          >
            {adding ? 'Adding…' : `Add ${picked.size} selected`}
          </Button>
        </div>
      </div>
      <div className="max-h-64 overflow-y-auto rounded border">
        {!loading && !visible.length && (
          <p className="p-3 text-xs text-muted-foreground">
            {available.length
              ? 'No problems match that filter.'
              : 'Every problem in this pool is already queued.'}
          </p>
        )}
        {visible.map((p) => (
          <div
            key={p.id}
            className="flex items-center gap-2 border-t p-1.5 text-xs first:border-t-0"
          >
            <input
              type="checkbox"
              checked={picked.has(p.id)}
              onChange={() => toggle(p.id)}
              className="size-3.5"
            />
            <span className="font-mono">{p.id}</span>
            <span className="flex-1 truncate text-muted-foreground">
              {p.informal ?? ''}
            </span>
            <button
              type="button"
              className="text-sky-600 underline-offset-2 hover:underline disabled:opacity-40"
              disabled={adding}
              onClick={() => onAddOne(p.id)}
            >
              + add
            </button>
          </div>
        ))}
      </div>
    </div>
  );
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
  const [expanded, setExpanded] = useState<string | null>(null);

  // The problem picker — ACG-style: the config above (benchmark/strategy/
  // model/label) sets up the SESSION, then you add exactly the problems you
  // want one at a time, in whatever order, rather than bulk-seeding N up
  // front. Pool is scoped to the SELECTED run's own benchmark (not the "new
  // session" dropdown above it), so adding to an existing FATE-X run always
  // offers FATE-X problems even if the top dropdown has since moved on.
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pool, setPool] = useState<PoolProblem[] | null>(null);
  const [poolLoading, setPoolLoading] = useState(false);
  const [poolFilter, setPoolFilter] = useState('');
  const [poolPicked, setPoolPicked] = useState<Set<string>>(new Set());
  const [adding, setAdding] = useState(false);

  const [slots, setSlots] = useState<Record<number, WorkerSlot>>({});
  const [running, setRunning] = useState(false);
  const [pauseMessage, setPauseMessage] = useState<string | null>(null);
  const [parallel, setParallel] = useState(1);
  const stopRef = useRef(false);
  const abortsRef = useRef<Map<number, AbortController>>(new Map());

  // Remember the worker count across visits — a time-boxed benchmark night
  // shouldn't have to re-pick it every session. Read in an effect (not the
  // useState initializer) so SSR and the first client render agree.
  useEffect(() => {
    const v = Number(window.localStorage.getItem('benchmark:parallel'));
    if (Number.isInteger(v) && v >= 1 && v <= MAX_PARALLEL) setParallel(v);
  }, []);
  useEffect(() => {
    window.localStorage.setItem('benchmark:parallel', String(parallel));
  }, [parallel]);

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

  const budget = useMemo(() => benchmarkBudgetFor(strategy), [strategy]);

  // A new session starts EMPTY — no bulk seed, no sample-size picker. The
  // picker below is how problems get added, one at a time or in a batch.
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
          problemIds: [], // empty session — add problems via the picker
          computeBudgetMs: budget.computeBudgetMs ?? null,
          maxIters: budget.maxIters ?? null,
        }),
      });
      if (res.ok) {
        const { run } = await res.json();
        setLabel('');
        await loadRuns();
        setSelected(run.id);
        setPickerOpen(true);
      }
    } finally {
      setCreating(false);
    }
  };

  // Load the picker's pool from the SELECTED run's own benchmark, not the
  // "new session" dropdown — so opening the picker on an existing FATE-X run
  // always shows FATE-X problems regardless of what's picked above.
  useEffect(() => {
    if (!pickerOpen || !selectedRun) return;
    let cancelled = false;
    setPoolLoading(true);
    fetch(`/api/admin/benchmark/pool?benchmark=${encodeURIComponent(selectedRun.benchmark)}`)
      .then((r) => (r.ok ? r.json() : { problems: [] }))
      .then((j) => {
        if (!cancelled) setPool(j.problems ?? []);
      })
      .finally(() => {
        if (!cancelled) setPoolLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [pickerOpen, selectedRun?.benchmark, selectedRun?.id]);

  // Reset picker selection/filter whenever the selected run changes, so stale
  // checkboxes from a different run's pool can never leak into an add_many call.
  useEffect(() => {
    setPoolPicked(new Set());
    setPoolFilter('');
    setPool(null);
  }, [selected]);

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

  // Already-queued problem ids for the selected run — the picker hides these
  // (or marks them added) so re-picking the same problem is a visible no-op,
  // not a silent duplicate click.
  const queuedIds = useMemo(
    () => new Set((items ?? []).map((it) => it.problemId)),
    [items],
  );

  const addOne = useCallback(
    async (problemId: string) => {
      if (!selected) return;
      await patchItem(selected, { action: 'add', problemId });
      await loadRun(selected);
      await loadRuns();
    },
    [selected, patchItem, loadRun, loadRuns],
  );

  const addMany = useCallback(
    async (problemIds: string[]) => {
      if (!selected || !problemIds.length) return;
      setAdding(true);
      try {
        await patchItem(selected, { action: 'add_many', problemIds });
        setPoolPicked(new Set());
        await loadRun(selected);
        await loadRuns();
      } finally {
        setAdding(false);
      }
    },
    [selected, patchItem, loadRun, loadRuns],
  );

  const removeQueued = useCallback(
    async (itemId: string) => {
      if (!selected) return;
      await patchItem(selected, { action: 'remove', itemId });
      await loadRun(selected);
      await loadRuns();
    },
    [selected, patchItem, loadRun, loadRuns],
  );

  // The resumable loop, now N workers wide: each worker independently claims
  // the next pending problem, proves it on the admin's connected bridge,
  // persists the outcome AND a research row, and claims again — so up to N
  // problems are in flight at once. The claim is row-locked server-side
  // (FOR UPDATE SKIP LOCKED), so two workers can never grab the same item.
  //
  // Failure triage is unchanged (see isCatastrophic), but in parallel a
  // quota/connectivity failure pauses EVERY worker: the one that hit it flips
  // stopRef and aborts its siblings, and each in-flight claim is handed back
  // unscored — a flat battery still never scores problems as misses. A failure
  // specific to one problem is retried once and then SKIPPED by that worker
  // alone; the others never notice.
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
    const workerCount = Math.min(Math.max(parallel, 1), MAX_PARALLEL);

    stopRef.current = false;
    setRunning(true);
    setPauseMessage(null);
    setSlots({});

    const setSlot = (slot: number, update: (prev: WorkerSlot) => WorkerSlot) =>
      setSlots((prev) => ({
        ...prev,
        [slot]: update(prev[slot] ?? { problemId: null, events: [] }),
      }));

    // Abort every OTHER worker's in-flight attempt. stopRef is already true by
    // the time this is called, so each sibling's catch releases its claim
    // unscored rather than retrying or skipping it.
    const abortSiblings = (except: number) => {
      for (const [slot, ctrl] of abortsRef.current) {
        if (slot !== except) ctrl.abort();
      }
    };

    const worker = async (slot: number, mcpServers: ProverMcpServer[]) => {
      while (!stopRef.current) {
        const claimRes = await fetch(`/api/admin/benchmark/${selected}/claim`, {
          method: 'POST',
        }).catch(() => null);
        if (!claimRes?.ok) {
          setPauseMessage(
            (prev) => prev ?? 'Could not reach the benchmark API — paused.',
          );
          break;
        }
        const { item } = (await claimRes.json()) as { item: ItemRow | null };
        if (!item) break; // queue drained — this worker is done
        setSlot(slot, () => ({ problemId: item.problemId, events: [] }));
        let content = '';
        let metrics: ProverOutcome['metrics'];
        const ctrl = new AbortController();
        abortsRef.current.set(slot, ctrl);

        // Safety net, NOT a cap on the prover: the bridge owns the run's real
        // deadline (runBudget.computeBudgetMs, which the operator chose). This
        // only fires well past it, when the stream has wedged and the bridge
        // has failed to honour its own budget — otherwise one hung socket
        // would stall the worker indefinitely.
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
              setSlot(slot, (s) => ({ ...s, events: [...s.events, ev] }));
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
          // Operator pressed Pause (or a sibling hit a catastrophic failure
          // and aborted us): never score, never count the attempt. The `prev
          // ??` keeps a sibling's more specific message if it got there first.
          if (stopRef.current) {
            await patchItem(selected, { action: 'release', itemId: item.id });
            setPauseMessage(
              (prev) =>
                prev ??
                `Paused on ${item.problemId} — progress saved, nothing scored. Click Resume to continue.`,
            );
            break;
          }
          if (isCatastrophic(msg, content)) {
            stopRef.current = true; // pause the whole pass, not just this worker
            abortSiblings(slot);
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
          abortsRef.current.delete(slot);
        }
        await loadRuns();
      }
    };

    try {
      const mcpServers: ProverMcpServer[] = await fetchProverMcpServers();
      await Promise.all(
        Array.from({ length: workerCount }, (_, slot) =>
          worker(slot, mcpServers),
        ),
      );
    } finally {
      abortsRef.current.clear();
      setRunning(false);
      if (selected) {
        loadRun(selected);
        loadRuns();
      }
    }
  }, [selected, runs, parallel, loadRuns, loadRun, patchItem]);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-2">
        <LocalClaudeAgentManagement />
        <MCPServerManagement />
      </div>

      <div className="rounded-lg border p-4">
        <h2 className="text-sm font-semibold">New session</h2>
        <p className="mt-1 text-xs text-muted-foreground">
          Runs on your connected bridge — up to {MAX_PARALLEL} problems at once
          (pick the worker count next to Start) — fully resumable —
          a usage limit or a closed laptop pauses the pass without scoring
          anything. Every attempt files a research row and stores its proof.
          A session starts empty — pick exactly the problems you want below
          after creating it.
        </p>
        <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <div className="lg:col-span-2">
            <Label className="text-xs">Benchmark (problem pool)</Label>
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
            <Label className="text-xs">Tag / label</Label>
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
          {creating ? 'Creating…' : 'Create session'}
        </Button>
      </div>

      <div className="space-y-2">
        <h2 className="text-sm font-semibold">Sessions</h2>
        {!runs?.length && (
          <p className="text-xs text-muted-foreground">
            No sessions yet — create one above.
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
              <Button
                size="sm"
                variant={pickerOpen ? 'secondary' : 'outline'}
                disabled={running}
                onClick={() => setPickerOpen((v) => !v)}
              >
                {pickerOpen ? 'Close picker' : '+ Add problems'}
              </Button>
              <select
                value={parallel}
                onChange={(e) => setParallel(Number(e.target.value))}
                disabled={running}
                title="How many problems to prove at once — each worker claims its own problem from the queue, so the pass finishes roughly this many times sooner"
                className="h-8 rounded-md border bg-background px-1.5 text-xs disabled:opacity-50"
              >
                {Array.from({ length: MAX_PARALLEL }, (_, i) => i + 1).map(
                  (n) => (
                    <option key={n} value={n}>
                      {n === 1 ? '1 worker' : `${n} workers`}
                    </option>
                  ),
                )}
              </select>
              {!running ? (
                <Button
                  size="sm"
                  disabled={!selectedRun.total}
                  title={!selectedRun.total ? 'Add problems below first' : undefined}
                  onClick={runLoop}
                >
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
                    // Stop claiming new items AND abort every in-flight
                    // attempt — a proof can run for its full budget, so
                    // without the aborts this button would do nothing until
                    // the slowest worker finished.
                    stopRef.current = true;
                    for (const ctrl of abortsRef.current.values()) ctrl.abort();
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

          {pickerOpen && (
            <PoolPicker
              pool={pool}
              loading={poolLoading}
              queuedIds={queuedIds}
              picked={poolPicked}
              setPicked={setPoolPicked}
              filter={poolFilter}
              setFilter={setPoolFilter}
              adding={adding}
              onAddOne={addOne}
              onAddMany={addMany}
            />
          )}

          {Object.keys(slots).length ? (
            <div
              className={cn(
                'grid gap-3',
                Object.keys(slots).length > 1 && 'lg:grid-cols-2',
              )}
            >
              {Object.entries(slots)
                .sort(([a], [b]) => Number(a) - Number(b))
                .map(([slot, s]) => (
                  <ProverConsole
                    key={slot}
                    events={s.events}
                    running={running}
                    title={
                      s.problemId
                        ? Object.keys(slots).length > 1
                          ? `Worker ${Number(slot) + 1} — ${s.problemId}`
                          : `Proving ${s.problemId}`
                        : `Worker ${Number(slot) + 1}`
                    }
                    emptyHint="Waiting for a claim…"
                  />
                ))}
            </div>
          ) : (
            <ProverConsole
              events={[]}
              running={running}
              title="Prover activity"
              emptyHint="Click Start/Resume to begin proving pending problems."
            />
          )}

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
                        {fmtAttemptTime(it)}
                      </td>
                      <td className="px-2 py-1">{it.attempts}</td>
                      <td className="px-2 py-1">
                        <div className="flex gap-1">
                          {it.status === 'pending' && (
                            <button
                              type="button"
                              disabled={running}
                              title="Drag this one out of the queue before it's ever attempted — pending only, use Skip once it's been tried"
                              className="text-[11px] text-destructive underline-offset-2 hover:underline disabled:opacity-40"
                              onClick={() => removeQueued(it.id)}
                            >
                              remove
                            </button>
                          )}
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
                            title="Resume here: make this the next problem the run claims, and requeue only the UN-SCORED (pending/skipped) items after it. Already-scored attempts (proved/unsolved/refuted) are never touched. Anything still pending BEFORE it is parked as skipped (restore with 'requeue skipped')."
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
