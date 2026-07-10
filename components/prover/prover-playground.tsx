'use client';

import { useCallback, useState } from 'react';
import { Loader2, Play, ShieldCheck, ShieldAlert, GitBranch } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { fetchProverMcpServers } from '@/lib/mcp/fetch-prover-servers';
import { runProverStream } from '@/lib/prover/run-prover-stream';
import { ProverConsole } from '@/components/prover/prover-console';
import type { ProverEvent, ProverOutcome } from '@/lib/prover/types';

// A minimal "message the prover" surface. It reuses the exact same runner +
// console as the admin queue resolver — send a statement, watch every step.
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

  const run = useCallback(async () => {
    if (!problem.trim()) return;
    setRunning(true);
    setEvents([]);
    setOutcome(null);
    const append = (e: ProverEvent) => setEvents((prev) => [...prev, e]);
    try {
      const mcpServers = await fetchProverMcpServers();
      const out = await runProverStream({
        problem,
        mcpServers,
        model: model || undefined,
        onEvent: append,
        source: decompose ? `playground-tree:${strategy}` : 'playground',
        endpoint: decompose ? 'prove-tree' : 'prove-stream',
        strategy: decompose ? strategy : undefined,
      });
      setOutcome(out);
    } catch {
      /* the console already shows the error event */
    } finally {
      setRunning(false);
    }
  }, [problem, decompose, strategy, model]);

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
        <Button onClick={run} disabled={running || !problem.trim()} className="gap-2">
          {running ? (
            <Loader2 className="size-4 animate-spin" />
          ) : (
            <Play className="size-4" />
          )}
          Send to prover
        </Button>
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
            value={model}
            onChange={(e) => setModel(e.target.value)}
            disabled={running}
            className="rounded-md border bg-background px-2 py-1.5 text-sm"
          >
            <option value="">Default</option>
            <option value="claude-opus-4-8">Opus 4.8</option>
            <option value="claude-sonnet-5">Sonnet 5</option>
            <option value="claude-fable-5">Fable 5</option>
            <option value="claude-haiku-4-5-20251001">Haiku 4.5</option>
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
            </select>
          </label>
        )}
      </div>
      {decompose && (
        <p className="text-xs text-muted-foreground">
          Prove-or-split: each goal gets a bounded direct attempt, then is broken
          into toolchain-verified sub-lemmas (recursively) and assembled into one
          sorry-free proof.{' '}
          {strategy === 'pantograph'
            ? 'Pantograph mode builds proofs interactively in Leak II; Leak IV is used only as the final guardrail.'
            : 'Hacker mode leads with the compiler (verify_full_script) and strong automation.'}{' '}
          Needs a verify_full_script MCP server connected.
        </p>
      )}

      <ProverConsole events={events} running={running} />

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
