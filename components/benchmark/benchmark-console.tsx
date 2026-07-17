'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
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

// Models selectable for the local `claude` runs (Claude Max plan) — same list
// admin-pipeline.tsx offers for verification.
const PROVER_MODELS: { value: string; label: string }[] = [
  { value: '', label: 'Default' },
  { value: 'claude-opus-4-8', label: 'Opus 4.8' },
  { value: 'claude-sonnet-5', label: 'Sonnet 5' },
  { value: 'claude-haiku-4-5-20251001', label: 'Haiku 4.5' },
  { value: 'claude-fable-5', label: 'Fable 5' },
];

const STRATEGIES: { value: string; label: string }[] = [
  { value: 'hacker', label: 'Hacker (compiler-driven)' },
  { value: 'pantograph', label: 'Pantograph (interactive Leak II)' },
  { value: 'librarian', label: 'Librarian (search-first control)' },
  { value: 'sketch', label: 'Sketch (plan then formalize)' },
  { value: 'brute', label: 'Brute (automation only)' },
  { value: 'have', label: 'Have (in-context, no top-level lemmas)' },
  { value: 'have-tree', label: 'V2 — have-tree (isolated per-hole minions)' },
  { value: 'blueprint', label: 'V3 — blueprint + global refinement' },
];

// Detect Claude's usage/session-limit message so the loop pauses (never scores
// the current item) instead of mis-marking it a prover failure — same
// heuristic as admin-pipeline.tsx's detectSessionLimit, kept local here to
// avoid coupling this standalone tool to that file.
function detectSessionLimit(text: string): boolean {
  const t = (text || '').trim();
  if (!/limit/i.test(t)) return false;
  return /(session|usage|rate)\s*limit|hit your|limit (reached|exceeded)/i.test(t);
}

interface RunRow {
  id: string;
  benchmark: string;
  label: string;
  model: string | null;
  strategy: string | null;
  decompose: boolean;
  total: number;
  createdAt: string;
  pending: number;
  running: number;
  proved: number;
  refuted: number;
  unsolved: number;
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
}

const SAMPLE_SIZES = [
  { label: 'Smoke test — first 10', value: 10 },
  { label: 'Quick pass — first 50', value: 50 },
  { label: 'Full miniF2F-test — all 244', value: 0 },
];

function StatusDot({ status }: { status: string }) {
  const color =
    status === 'proved'
      ? 'bg-emerald-500'
      : status === 'refuted'
        ? 'bg-amber-500'
        : status === 'unsolved'
          ? 'bg-destructive'
          : status === 'running'
            ? 'bg-sky-500 animate-pulse'
            : 'bg-muted-foreground/40';
  return <span className={cn('inline-block size-2 rounded-full', color)} />;
}

function ProgressBar({ run }: { run: RunRow }) {
  const done = run.proved + run.refuted + run.unsolved;
  const pct = run.total ? (done / run.total) * 100 : 0;
  const passPct = run.total ? (run.proved / run.total) * 100 : 0;
  return (
    <div className="space-y-1">
      <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
        <div
          className="h-full bg-emerald-500"
          style={{ width: `${passPct}%` }}
        />
        <div
          className="-mt-2 h-full bg-foreground/20"
          style={{ width: `${pct}%` }}
        />
      </div>
      <p className="font-mono text-xs text-muted-foreground">
        {done}/{run.total} attempted · {run.proved} proved (
        {pct ? passPct.toFixed(1) : '0.0'}%) · {run.refuted} refuted ·{' '}
        {run.unsolved} unsolved · ${run.costUsd.toFixed(2)} spent
      </p>
    </div>
  );
}

export function BenchmarkConsole() {
  const [runs, setRuns] = useState<RunRow[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [items, setItems] = useState<ItemRow[] | null>(null);
  const [creating, setCreating] = useState(false);
  const [label, setLabel] = useState('');
  const [model, setModel] = useState('claude-opus-4-8');
  const [decompose, setDecompose] = useState(false);
  const [strategy, setStrategy] = useState('have-tree');
  const [sampleSize, setSampleSize] = useState(10);

  const [events, setEvents] = useState<ProverEvent[]>([]);
  const [running, setRunning] = useState(false);
  const [pauseMessage, setPauseMessage] = useState<string | null>(null);
  const [currentProblemId, setCurrentProblemId] = useState<string | null>(null);
  const stopRef = useRef(false);
  const abortRef = useRef<AbortController | null>(null);

  const loadRuns = useCallback(async () => {
    const res = await fetch('/api/admin/benchmark');
    if (res.ok) setRuns((await res.json()).runs);
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

  const createRun = async () => {
    setCreating(true);
    try {
      const res = await fetch('/api/admin/benchmark', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          label: label.trim() || `Leak run — ${new Date().toLocaleString()}`,
          model,
          strategy: decompose ? strategy : null,
          decompose,
          limit: sampleSize || undefined,
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

  const patchItem = async (runId: string, body: Record<string, unknown>) => {
    await fetch(`/api/admin/benchmark/${runId}/item`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }).catch(() => {});
  };

  // The resumable loop: claim the next pending problem, prove it on the
  // admin's connected bridge, persist the outcome, repeat. ANY exception from
  // runProverStream (bridge unreachable, protocol error, Claude Max session
  // limit) pauses the loop and hands the claim back to `pending` — so a quota
  // hiccup or closed laptop lid never scores a problem as "unsolved". Only a
  // clean `done` outcome (verified / refuted / neither) is ever recorded.
  const runLoop = useCallback(async () => {
    if (!selected) return;
    stopRef.current = false;
    setRunning(true);
    setPauseMessage(null);
    try {
      const mcpServers: ProverMcpServer[] = await fetchProverMcpServers();
      while (!stopRef.current) {
        const claimRes = await fetch(
          `/api/admin/benchmark/${selected}/claim`,
          { method: 'POST' },
        );
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
        const ctrl = new AbortController();
        abortRef.current = ctrl;
        try {
          const outcome: ProverOutcome = await runProverStream({
            problem: item.statement,
            mcpServers,
            model: model || undefined,
            signal: ctrl.signal,
            onEvent: (ev) => {
              setEvents((prev) => [...prev, ev]);
              content += ` ${ev.label || ''} ${ev.detail || ''}`;
            },
            source: `benchmark:${item.problemId}`,
            endpoint: decompose ? 'prove-tree' : 'prove-stream',
            strategy: decompose ? strategy : undefined,
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
          });
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          await patchItem(selected, { action: 'release', itemId: item.id });
          setPauseMessage(
            stopRef.current
              ? `Paused on ${item.problemId} — progress saved, nothing scored. Click Resume to continue.`
              : detectSessionLimit(content) || detectSessionLimit(msg)
                ? `Claude Max session limit hit while proving ${item.problemId} — paused. Progress is saved; click Resume once your limit resets.`
                : `Bridge/connectivity error on ${item.problemId} — paused (nothing scored). ${msg.slice(0, 160)}`,
          );
          break;
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
  }, [selected, model, decompose, strategy, loadRuns, loadRun]);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-2">
        <LocalClaudeAgentManagement />
        <MCPServerManagement />
      </div>

      <div className="rounded-lg border p-4">
        <h2 className="text-sm font-semibold">New miniF2F-test run</h2>
        <p className="mt-1 text-xs text-muted-foreground">
          244 formal Lean 4 statements (AMC/AIME/IMO + early-undergrad
          competition math) — the standard cross-paper capability benchmark.
          Runs on your connected Claude Max bridge; fully resumable if your
          usage limit resets mid-run.
        </p>
        <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <div>
            <Label className="text-xs">Label</Label>
            <Input
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="Leak V2 baseline"
              className="mt-1 h-8 text-sm"
            />
          </div>
          <div>
            <Label className="text-xs">Model</Label>
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
          <div>
            <Label className="text-xs">Sample size</Label>
            <select
              value={sampleSize}
              onChange={(e) => setSampleSize(Number(e.target.value))}
              className="mt-1 h-8 w-full rounded-md border bg-background px-2 text-sm"
            >
              {SAMPLE_SIZES.map((s) => (
                <option key={s.value} value={s.value}>
                  {s.label}
                </option>
              ))}
            </select>
          </div>
          <div>
            <Label className="text-xs">Strategy</Label>
            <div className="mt-1 flex items-center gap-2">
              <input
                id="bench-decompose"
                type="checkbox"
                checked={decompose}
                onChange={(e) => setDecompose(e.target.checked)}
                className="size-3.5"
              />
              <select
                value={strategy}
                onChange={(e) => setStrategy(e.target.value)}
                disabled={!decompose}
                className="h-8 w-full rounded-md border bg-background px-2 text-sm disabled:opacity-50"
              >
                {STRATEGIES.map((s) => (
                  <option key={s.value} value={s.value}>
                    {s.label}
                  </option>
                ))}
              </select>
            </div>
          </div>
        </div>
        <Button
          size="sm"
          className="mt-3"
          disabled={creating}
          onClick={createRun}
        >
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
                  {r.model || 'default'}
                  {r.decompose ? ` · ${r.strategy}` : ''}
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
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold">{selectedRun.label}</h3>
            <div className="flex items-center gap-2">
              {!running ? (
                <Button size="sm" onClick={runLoop}>
                  {selectedRun.proved +
                    selectedRun.refuted +
                    selectedRun.unsolved >
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
                    // a proof can run unbounded (no artificial caps), so without
                    // the abort this button would silently do nothing until the
                    // current attempt finished on its own.
                    stopRef.current = true;
                    abortRef.current?.abort();
                  }}
                >
                  Pause
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

          <div className="max-h-96 overflow-y-auto rounded-md border">
            <table className="w-full text-xs">
              <thead className="sticky top-0 bg-muted/80 backdrop-blur">
                <tr className="text-left">
                  <th className="px-2 py-1.5 font-medium">Problem</th>
                  <th className="px-2 py-1.5 font-medium">Status</th>
                  <th className="px-2 py-1.5 font-medium">Cost</th>
                  <th className="px-2 py-1.5 font-medium">Attempts</th>
                </tr>
              </thead>
              <tbody>
                {items?.map((it) => (
                  <tr key={it.id} className="border-t">
                    <td className="px-2 py-1 font-mono">{it.problemId}</td>
                    <td className="px-2 py-1">
                      <span className="inline-flex items-center gap-1.5">
                        <StatusDot status={it.status} />
                        {it.status}
                      </span>
                    </td>
                    <td className="px-2 py-1 font-mono">
                      {it.costUsd != null ? `$${it.costUsd.toFixed(3)}` : '—'}
                    </td>
                    <td className="px-2 py-1">{it.attempts}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
