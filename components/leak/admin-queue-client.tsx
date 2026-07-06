'use client';

import { useCallback, useMemo, useState } from 'react';
import Link from 'next/link';
import { Check, Loader2, RefreshCw, X, Coins, ArrowLeft } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';

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

export function AdminQueueClient({ initialJobs }: { initialJobs: JobView[] }) {
  const [jobs, setJobs] = useState<JobView[]>(initialJobs);
  const [proofs, setProofs] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [granting, setGranting] = useState(false);

  const { open, resolved } = useMemo(() => {
    const open: JobView[] = [];
    const resolved: JobView[] = [];
    for (const j of jobs) (OPEN.has(j.status) ? open : resolved).push(j);
    return { open, resolved };
  }, [jobs]);

  const origin = typeof window !== 'undefined' ? window.location.origin : '';
  const workerCmd = `curl -fsSL '${origin}/local-claude-bridge.mjs' -o claude-bridge.mjs && \\
WORKER_URL='${origin}' WORKER_SECRET='<LEAK_WORKER_SECRET>' WORKER_MODEL='claude-opus-4-8' \\
  node claude-bridge.mjs`;

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
    <div className="mx-auto max-w-3xl px-6 py-16">
      <div className="mb-8 flex items-center justify-between">
        <div>
          <Link
            href="/dashboard"
            className="mb-2 inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
          >
            <ArrowLeft className="size-3" /> Dashboard
          </Link>
          <h1 className="text-2xl font-semibold tracking-tight">
            Resolution queue
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Real submissions awaiting a proof. Resolve here from your device, or
            let the live worker drain them.
          </p>
        </div>
        <div className="flex items-center gap-2">
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
            +20 test credits
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

      {/* Open queue */}
      <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide">
        Open ({open.length})
      </h2>
      {open.length === 0 ? (
        <p className="mb-10 rounded-lg border border-dashed px-4 py-8 text-center text-sm text-muted-foreground">
          Queue is empty — nothing to resolve.
        </p>
      ) : (
        <div className="mb-10 space-y-4">
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
              <Textarea
                placeholder="Paste the Lean proof here…"
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
                  className="gap-1.5"
                  disabled={busy === j.id || !(proofs[j.id] ?? '').trim()}
                  onClick={() => resolve(j.id, { proof: proofs[j.id] })}
                >
                  {busy === j.id ? (
                    <Loader2 className="size-3.5 animate-spin" />
                  ) : (
                    <Check className="size-3.5" />
                  )}
                  Mark proved (capture {j.quotedCredits ?? 0} cr)
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

      {/* Recently resolved */}
      <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide">
        Recently resolved
      </h2>
      {resolved.length === 0 ? (
        <p className="text-sm text-muted-foreground">Nothing yet.</p>
      ) : (
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
      )}

      {/* Run a worker to drain the queue automatically */}
      <div className="mt-10 rounded-lg border bg-muted/40 p-4">
        <p className="mb-1 text-sm font-semibold">Drain automatically</p>
        <p className="mb-3 text-xs text-muted-foreground">
          Run this on your machine (with Claude Code logged in) to prove queued
          problems on your Max/Opus plan. Replace{' '}
          <code className="font-mono">&lt;LEAK_WORKER_SECRET&gt;</code> with the
          value from your app env.
        </p>
        <pre className="overflow-x-auto rounded bg-background/60 p-3 font-mono text-[11px] leading-relaxed">
          {workerCmd}
        </pre>
      </div>
    </div>
  );
}
