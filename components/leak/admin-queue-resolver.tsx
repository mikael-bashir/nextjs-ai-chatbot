'use client';

import { useCallback, useMemo, useState } from 'react';
import {
  Check,
  Loader2,
  RefreshCw,
  X,
  Coins,
  Cpu,
  Zap,
} from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import {
  fetchProverMcpServers,
  type ProverMcpServer,
} from '@/lib/mcp/fetch-prover-servers';

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

// ── Bridge connection (same localStorage contract AdminPipeline uses) ────────
function bridgeConn(): { bridgeUrl?: string; token?: string } {
  try {
    return JSON.parse(localStorage.getItem('lca.connection') || '{}');
  } catch {
    return {};
  }
}
function bridgeBase(conn: { bridgeUrl?: string }): string {
  let b = (conn.bridgeUrl || 'http://localhost:4123').replace(/\/$/, '');
  if (!/^https?:\/\//i.test(b)) b = `http://${b}`;
  return b;
}

export interface ProveOutcome {
  verified: boolean;
  proof: string;
}

// Prove a problem on the local Claude bridge with the given MCP servers, using
// the SAME /prove-stream endpoint + guardrail (`done.verified`) as generation.
async function proveOnBridge(
  problem: string,
  mcpServers: ProverMcpServer[],
  onTool: (tool: string) => void,
): Promise<ProveOutcome> {
  const conn = bridgeConn();
  const res = await fetch(`${bridgeBase(conn)}/prove-stream`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-bridge-token': conn.token || '',
    },
    body: JSON.stringify({ theorem: problem, mcpServers }),
  });
  if (!res.ok || !res.body) throw new Error(`bridge returned ${res.status}`);

  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  let outcome: ProveOutcome | null = null;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const events = buf.split('\n\n');
    buf = events.pop() || '';
    for (const e of events) {
      if (!e.startsWith('data:')) continue;
      try {
        const d = JSON.parse(e.replace(/^data:\s*/, ''));
        if (d.type === 'message-annotation' && d.tool) onTool(String(d.tool));
        if (d.type === 'done')
          outcome = { verified: !!d.verified, proof: d.proof || '' };
      } catch {
        /* ignore malformed event */
      }
    }
  }
  if (!outcome) throw new Error('prove stream ended without a result');
  return outcome;
}

export function AdminQueueResolver({
  initialJobs,
}: {
  initialJobs: JobView[];
}) {
  const [jobs, setJobs] = useState<JobView[]>(initialJobs);
  const [proofs, setProofs] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null); // manual resolve
  const [provingId, setProvingId] = useState<string | null>(null); // bridge prove
  const [activity, setActivity] = useState<string[]>([]);
  const [note, setNote] = useState<Record<string, string>>({});
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

  // Prove one job on the bridge; auto-resolve only if the guardrail verified it.
  const proveWithBridge = useCallback(
    async (job: JobView): Promise<ProveOutcome | null> => {
      setProvingId(job.id);
      setActivity([]);
      setNote((n) => ({ ...n, [job.id]: '' }));
      try {
        const mcpServers = await fetchProverMcpServers();
        const out = await proveOnBridge(job.problem, mcpServers, (tool) =>
          setActivity((a) => [...a.slice(-11), tool]),
        );
        if (out.verified && out.proof.trim()) {
          await resolve(job.id, { proof: out.proof });
          return out;
        }
        // Not verified: surface the draft proof for manual review, don't charge.
        setProofs((p) => ({ ...p, [job.id]: out.proof }));
        setNote((n) => ({
          ...n,
          [job.id]: out.proof
            ? 'Bridge produced a proof but it did NOT verify against your MCP server — review before resolving.'
            : 'Bridge could not produce a verified proof.',
        }));
        return out;
      } catch (e) {
        setNote((n) => ({ ...n, [job.id]: `Bridge error: ${String(e)}` }));
        return null;
      } finally {
        setProvingId(null);
      }
    },
    [resolve],
  );

  // Prove every open job in sequence (stop on the first bridge/connection error).
  const autoDrain = useCallback(async () => {
    setDraining(true);
    try {
      for (const job of open) {
        if (!OPEN.has(job.status)) continue;
        const out = await proveWithBridge(job);
        if (out === null) break; // bridge unreachable — stop the run
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
            Prove real submissions on your bridge — auto-resolves only when your
            MCP server verifies the proof.
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
            <RefreshCw
              className={`size-3.5 ${refreshing ? 'animate-spin' : ''}`}
            />
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

              {/* Prove on the bridge (guardrailed) */}
              <div className="mb-3 flex flex-wrap items-center gap-2">
                <Button
                  size="sm"
                  className="gap-1.5"
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
                {provingId === j.id && activity.length > 0 && (
                  <div className="flex flex-wrap gap-1">
                    {activity.map((t, i) => (
                      <span
                        key={`${t}-${i}`}
                        className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground"
                      >
                        {t}
                      </span>
                    ))}
                  </div>
                )}
              </div>
              {note[j.id] && (
                <p className="mb-2 text-xs text-amber-600 dark:text-amber-400">
                  {note[j.id]}
                </p>
              )}

              {/* Manual review / override */}
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
                  onClick={() =>
                    resolve(j.id, { error: 'Could not be proven.' })
                  }
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
