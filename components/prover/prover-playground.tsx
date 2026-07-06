'use client';

import { useCallback, useState } from 'react';
import { Loader2, Play, ShieldCheck, ShieldAlert } from 'lucide-react';

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

  const run = useCallback(async () => {
    if (!problem.trim()) return;
    setRunning(true);
    setEvents([]);
    setOutcome(null);
    const append = (e: ProverEvent) => setEvents((prev) => [...prev, e]);
    try {
      const mcpServers = await fetchProverMcpServers();
      const out = await runProverStream({ problem, mcpServers, onEvent: append, source: 'playground' });
      setOutcome(out);
    } catch {
      /* the console already shows the error event */
    } finally {
      setRunning(false);
    }
  }, [problem]);

  return (
    <div className="space-y-4">
      <Textarea
        value={problem}
        onChange={(e) => setProblem(e.target.value)}
        rows={4}
        className="font-mono text-sm"
        placeholder="Enter a statement (Lean theorem, or a problem to prove)…"
      />
      <Button onClick={run} disabled={running || !problem.trim()} className="gap-2">
        {running ? (
          <Loader2 className="size-4 animate-spin" />
        ) : (
          <Play className="size-4" />
        )}
        Send to prover
      </Button>

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
