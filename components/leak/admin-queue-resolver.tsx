'use client';

import { useCallback, useMemo, useState } from 'react';
import { Check, Loader2, RefreshCw, X, Coins, Cpu, Zap } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { fetchProverMcpServers } from '@/lib/mcp/fetch-prover-servers';
import { runProverStream } from '@/lib/prover/run-prover-stream';
import { ProverConsole } from '@/components/prover/prover-console';
import type { ProverEvent, ProverOutcome } from '@/lib/prover/types';

interface JobView {
  id: string;
  status: string;
  problem: string;
  quotedCredits: number | null;
  chargedCredits: number | null;
  leasedBy: string | null;
  createdAt: string;
  finishedAt: string | null;
}

const OPEN = new Set(['queued', 'leased', 'proving']);

const STATUS_STYLE: Record<string, string> = {
  queued: 'bg-amber-500/15 text-amber-600 dark:text-amber-400',
  leased: 'bg-blue-500/15 text-blue-600 dark:text-blue-400',
  proving: 'bg-blue-500/15 text-blue-600 dark:text-blue-400',
  proved: 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400',
  failed: 'bg-destructive/15 text-destructive',
};

export function AdminQueueResolver({
  initialJobs,
}: {
  initialJobs: JobView[];
}) {
  const [jobs, setJobs] = useState<JobView[]>(initialJobs);
  const [proofs, setProofs] = useState<Record<string, string>>({});
  const [events, setEvents] = useState<Record<string, ProverEvent[]>>({});
  const [note, setNote] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null); // manual resolve
  const [provingId, setProvingId] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [granting, setGranting] = useState(false);
  const [draining, setDraining] = useState(false);

  const { open, resolved } = useMemo(() => {
    const open: JobView[] = [];
    const resolved: JobView[] = [];
    for (const j of jobs) (OPEN.has(j.status) ? open : resolved).push(j);
    return { open, resolved };
  }, [jobs]);

  const refresh = useCallback(async () => {
    setRefreshing(true);
    try {
      const res = await fetch('/api/admin/queue');
      const data = await res.json();
      if (res.ok) setJobs(data.jobs);
    } finally {
      setRefreshing(false);
    }
  }, []);

  const resolve = useCallback(
    async (id: string, payload: { proof?: string; error?: string }) => {
      setBusy(id);
      try {
        const res = await fetch(`/api/admin/queue/${id}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload),
        });
        if (res.ok) await refresh();
      } finally {
        setBusy(null);
      }
    },
    [refresh],
  );

  // Prove a job on the bridge, streaming every step into its console. Only
  // auto-resolves when the guardrail verified the proof.
  const proveWithBridge = useCallback(
    async (job: JobView): Promise<ProverOutcome | null> => {
      setProvingId(job.id);
      setEvents((m) => ({ ...m, [job.id]: [] }));
      setNote((n) => ({ ...n, [job.id]: '' }));
      const append = (e: ProverEvent) =>
        setEvents((m) => ({ ...m, [job.id]: [...(m[job.id] ?? []), e] }));
      try {
        const mcpServers = await fetchProverMcpServers();
        const out = await runProverStream({
          problem: job.problem,
          mcpServers,
          onEvent: append,
          source: 'queue',
        });
        if (out.verified && out.proof.trim()) {
          await resolve(job.id, { proof: out.proof });
        } else {
          setProofs((p) => ({ ...p, [job.id]: out.proof }));
          setNote((n) => ({
            ...n,
            [job.id]: out.proof
              ? 'Produced a proof but it did NOT verify — review before resolving.'
              : 'No verified proof produced.',
          }));
        }
        return out;
      } catch {
        return null; // event stream already logged the error
      } finally {
        setProvingId(null);
      }
    },
    [resolve],
  );

  const autoDrain = useCallback(async () => {
    setDraining(true);
    try {
      for (const job of open) {
        if (!OPEN.has(job.status)) continue;
        const out = await proveWithBridge(job);
        if (out === null) break; // bridge unreachable — stop
      }
      await refresh();
    } finally {
      setDraining(false);
    }
  }, [open, proveWithBridge, refresh]);

  const grantSelf = useCallback(async () => {
    setGranting(true);
    try {
      await fetch('/api/admin/grant-credits', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ amount: 20 }),
      });
    } finally {
      setGranting(false);
    }
  }, []);

  return (
    <section className="rounded-xl border bg-card p-5">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold tracking-tight">
            API resolution queue
          </h2>
          <p className="mt-0.5 text-sm text-muted-foreground">
            Prove real submissions on your bridge — every step is logged below,
            and a job resolves only when your MCP server verifies the proof.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            onClick={autoDrain}
            disabled={draining || open.length === 0}
            className="gap-1.5"
          >
            {draining ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <Zap className="size-3.5" />
            )}
            Prove all ({open.length})
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={grantSelf}
            disabled={granting}
            className="gap-1.5"
          >
            {granting ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <Coins className="size-3.5" />
            )}
            +20 credits
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={refresh}
            disabled={refreshing}
            className="gap-1.5"
          >
            <RefreshCw className={`size-3.5 ${refreshing ? 'animate-spin' : ''}`} />
            Refresh
          </Button>
        </div>
      </div>

      {open.length === 0 ? (
        <p className="rounded-lg border border-dashed px-4 py-8 text-center text-sm text-muted-foreground">
          Queue is empty — nothing to resolve.
        </p>
      ) : (
        <div className="space-y-4">
          {open.map((j) => (
            <div key={j.id} className="rounded-lg border p-4">
              <div className="mb-2 flex items-center gap-2">
                <span
                  className={`rounded px-1.5 py-0.5 font-mono text-[10px] uppercase ${STATUS_STYLE[j.status] ?? ''}`}
                >
                  {j.status}
                </span>
                <span className="font-mono text-xs text-muted-foreground">
                  {j.quotedCredits ?? 0} cr
                </span>
                <span className="ml-auto font-mono text-[10px] text-muted-foreground">
                  {j.id.slice(0, 8)}
                </span>
              </div>
              <p className="mb-3 whitespace-pre-wrap text-sm">{j.problem}</p>

              <div className="mb-3">
                <Button
                  size="sm"
                  className="mb-2 gap-1.5"
                  disabled={provingId === j.id || draining}
                  onClick={() => proveWithBridge(j)}
                >
                  {provingId === j.id ? (
                    <Loader2 className="size-3.5 animate-spin" />
                  ) : (
                    <Cpu className="size-3.5" />
                  )}
                  Prove on bridge
                </Button>
                {(events[j.id]?.length ?? 0) > 0 && (
                  <ProverConsole
                    events={events[j.id] ?? []}
                    running={provingId === j.id}
                  />
                )}
              </div>
              {note[j.id] && (
                <p className="mb-2 text-xs text-amber-600 dark:text-amber-400">
                  {note[j.id]}
                </p>
              )}

              <Textarea
                placeholder="Or paste a Lean proof to resolve manually…"
                value={proofs[j.id] ?? ''}
                onChange={(e) =>
                  setProofs((p) => ({ ...p, [j.id]: e.target.value }))
                }
                rows={3}
                className="mb-2 font-mono text-xs"
              />
              <div className="flex gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  className="gap-1.5"
                  disabled={busy === j.id || !(proofs[j.id] ?? '').trim()}
                  onClick={() => resolve(j.id, { proof: proofs[j.id] })}
                >
                  <Check className="size-3.5" />
                  Mark proved ({j.quotedCredits ?? 0} cr)
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  className="gap-1.5 text-destructive"
                  disabled={busy === j.id}
                  onClick={() => resolve(j.id, { error: 'Could not be proven.' })}
                >
                  <X className="size-3.5" />
                  Mark failed (no charge)
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}

      {resolved.length > 0 && (
        <>
          <h3 className="mb-2 mt-8 text-sm font-semibold uppercase tracking-wide">
            Recently resolved
          </h3>
          <ul className="divide-y rounded-lg border">
            {resolved.map((j) => (
              <li key={j.id} className="flex items-center gap-3 px-4 py-2.5">
                <span
                  className={`rounded px-1.5 py-0.5 font-mono text-[10px] uppercase ${STATUS_STYLE[j.status] ?? ''}`}
                >
                  {j.status}
                </span>
                <span className="truncate text-sm text-muted-foreground">
                  {j.problem}
                </span>
                <span className="ml-auto shrink-0 font-mono text-xs text-muted-foreground">
                  {j.chargedCredits ?? 0} cr
                </span>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
