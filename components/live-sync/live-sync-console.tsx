'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
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

interface UnprovenProblem {
  questionId: number;
  title: string;
  subtitle: string | null;
  content: string;
  difficulty: string;
  topic: string | null;
  knowledge: string | null;
}

type ItemStatus = 'idle' | 'proving' | 'attaching' | 'attached' | 'unsolved' | 'error';

export function LiveSyncConsole() {
  const [problems, setProblems] = useState<UnprovenProblem[] | null>(null);
  const [statuses, setStatuses] = useState<Record<number, ItemStatus>>({});
  const [messages, setMessages] = useState<Record<number, string>>({});
  const [model, setModel] = useState('claude-opus-4-8');
  const [decompose, setDecompose] = useState(true);
  const [strategy, setStrategy] = useState('blueprint');
  const [activeId, setActiveId] = useState<number | null>(null);
  const [events, setEvents] = useState<ProverEvent[]>([]);
  const abortRef = useRef<AbortController | null>(null);

  const load = useCallback(async () => {
    const res = await fetch('/api/admin/live-sync/unproven');
    if (res.ok) {
      const data = await res.json();
      setProblems(data.problems ?? []);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const setStatus = (id: number, status: ItemStatus, message?: string) => {
    setStatuses((s) => ({ ...s, [id]: status }));
    if (message !== undefined) setMessages((m) => ({ ...m, [id]: message }));
  };

  // Prove one problem, sign the certificate, and attach it to the already-live
  // CompeteMath row. Any failure (unsolved, aborted, unreachable bridge) just
  // leaves the problem in the unproven list untouched — nothing partial is
  // ever written to CompeteMath, `attach-proof` only ever fires on a genuine
  // verified outcome.
  const prove = async (p: UnprovenProblem) => {
    setActiveId(p.questionId);
    setEvents([]);
    setStatus(p.questionId, 'proving');
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    try {
      const mcpServers: ProverMcpServer[] = await fetchProverMcpServers();
      const outcome: ProverOutcome = await runProverStream({
        problem: p.content,
        mcpServers,
        model: model || undefined,
        signal: ctrl.signal,
        onEvent: (ev) => setEvents((prev) => [...prev, ev]),
        source: `push-prove:${p.questionId}`,
        endpoint: decompose ? 'prove-tree' : 'prove-stream',
        strategy: decompose ? strategy : undefined,
      });

      if (!outcome.verified || !outcome.proof) {
        setStatus(p.questionId, 'unsolved', 'Not proved this attempt — still live, try again anytime.');
        return;
      }

      setStatus(p.questionId, 'attaching');
      const verifiedAt = new Date().toISOString();
      const signRes = await fetch('/api/admin/certificate/sign', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ proof: outcome.proof, title: p.title, verifiedAt }),
      });
      const sig = signRes.ok
        ? await signRes.json()
        : { signature: null, keyId: null, certMintedAt: null };

      const attachRes = await fetch('/api/admin/live-sync/attach-proof', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          title: p.title,
          proof: outcome.proof,
          provedAt: verifiedAt,
          signature: sig.signature,
          signatureKeyId: sig.keyId,
          certMintedAt: sig.certMintedAt,
        }),
      });
      if (attachRes.ok) {
        setStatus(p.questionId, 'attached', 'Certificate attached — live problem is now proved.');
        setProblems((cur) => cur?.filter((x) => x.questionId !== p.questionId) ?? cur);
      } else {
        const err = await attachRes.json().catch(() => ({}));
        setStatus(p.questionId, 'error', err?.error || 'CompeteMath rejected the attach — check it wasn\'t already proved elsewhere.');
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setStatus(p.questionId, 'error', msg.slice(0, 200));
    } finally {
      setActiveId(null);
    }
  };

  const stop = () => {
    abortRef.current?.abort();
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-2">
        <LocalClaudeAgentManagement />
        <MCPServerManagement />
      </div>

      <div className="rounded-lg border p-4">
        <h2 className="text-sm font-semibold">Push prove</h2>
        <p className="mt-1 text-xs text-muted-foreground">
          Problems that are already live on CompeteMath but were promoted before
          they were proven. Prove one here and its certificate attaches straight
          onto the existing live row — no re-promotion, no new queue entry.
        </p>
        <div className="mt-3 grid gap-3 sm:grid-cols-3">
          <div>
            <label className="text-xs text-muted-foreground" htmlFor="ls-model">Model</label>
            <select
              id="ls-model"
              value={model}
              onChange={(e) => setModel(e.target.value)}
              className="mt-1 h-8 w-full rounded-md border bg-background px-2 text-sm"
            >
              {PROVER_MODELS.map((m) => (
                <option key={m.value} value={m.value}>{m.label}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="text-xs text-muted-foreground" htmlFor="ls-strategy">Strategy</label>
            <div className="mt-1 flex items-center gap-2">
              <input
                id="ls-decompose"
                type="checkbox"
                checked={decompose}
                onChange={(e) => setDecompose(e.target.checked)}
                className="size-3.5"
              />
              <select
                id="ls-strategy"
                value={strategy}
                onChange={(e) => setStrategy(e.target.value)}
                disabled={!decompose}
                className="h-8 w-full rounded-md border bg-background px-2 text-sm disabled:opacity-50"
              >
                {STRATEGIES.map((s) => (
                  <option key={s.value} value={s.value}>{s.label}</option>
                ))}
              </select>
            </div>
          </div>
        </div>
      </div>

      <div className="space-y-2">
        {problems === null && (
          <p className="text-xs text-muted-foreground">Loading…</p>
        )}
        {problems?.length === 0 && (
          <p className="text-xs text-muted-foreground">
            Nothing to do — every live problem already has a proof.
          </p>
        )}
        {problems?.map((p) => {
          const status = statuses[p.questionId] ?? 'idle';
          const busy = status === 'proving' || status === 'attaching';
          return (
            <div key={p.questionId} className="rounded-lg border p-3">
              <div className="flex items-center justify-between gap-2">
                <div>
                  <span className="text-sm font-medium">{p.title}</span>
                  <span className="ml-2 font-mono text-[11px] text-muted-foreground">
                    {p.difficulty}{p.topic ? ` · ${p.topic}` : ''}
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  {busy ? (
                    <Button size="sm" variant="outline" onClick={stop}>
                      Stop
                    </Button>
                  ) : (
                    <Button size="sm" onClick={() => prove(p)} disabled={activeId !== null}>
                      Prove
                    </Button>
                  )}
                </div>
              </div>
              {messages[p.questionId] && (
                <p
                  className={cn(
                    'mt-2 text-xs',
                    status === 'attached' && 'text-emerald-600 dark:text-emerald-400',
                    status === 'error' && 'text-destructive',
                    status === 'unsolved' && 'text-amber-600 dark:text-amber-400',
                  )}
                >
                  {messages[p.questionId]}
                </p>
              )}
            </div>
          );
        })}
      </div>

      {activeId !== null && (
        <ProverConsole
          events={events}
          running={statuses[activeId] === 'proving'}
          title={`Proving problem #${activeId}`}
          emptyHint="Waiting for the first event…"
        />
      )}
    </div>
  );
}
