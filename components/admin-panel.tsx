'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useSession } from 'next-auth/react';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import { Separator } from '@/components/ui/separator';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';
import { isAdminEmail } from '@/lib/admin';

// Ask Claude for a fresh, original, hand-solvable, integer-answer problem plus a
// Lean 4 theorem stating the answer. The prover then filters: only problems whose
// Lean theorem actually verifies get queued.
const GEN_PROMPT = `You are a creative competition-math problem setter. Invent ONE original problem.

Requirements:
- Creative and NON-standard: not a textbook exercise, not a famous/known competition problem, not a classic named result. Fresh setup and phrasing.
- The answer is a specific INTEGER.
- Solvable BY HAND with at most a basic calculator: it must hinge on an elegant insight, NOT brute force or a computer. A strong student derives the integer on paper.
- Provide a Lean 4 theorem stating the exact answer, provable in Mathlib. STRONGLY prefer a statement decidable by decide/native_decide over a SMALL finite domain (Fin n, Finset.range n, Finset.Icc, functions between small Fin types) so it is machine-checkable, or a clean closed-form equality. It MUST be true — compute the answer correctly. Assume "import Mathlib" is present; do NOT include imports.
- Also give it presentation metadata: a short evocative title, a 1-3 word subtitle, a difficulty of exactly "Easy" | "Medium" | "Hard" | "Extreme", and points = 50 for Easy, 100 for Medium, 150 for Hard, 200 for Extreme.

Respond with ONLY this JSON object, nothing else:
{"questionTitle":"<short evocative title>","subtitle":"<1-3 word tagline>","problem":"<self-contained statement>","answer":<integer>,"difficulty":"Easy|Medium|Hard|Extreme","points":<50|100|150|200>,"insight":"<key trick, 1-2 sentences>","lean":"theorem name : <statement encoding the integer answer> := by sorry"}`;

const TOOLCHAIN = 'leanprover/lean4:v4.29.1';

interface GenProblem {
  questionTitle?: string;
  subtitle?: string;
  problem?: string;
  answer?: number;
  difficulty?: string;
  points?: number;
  insight?: string;
  lean?: string;
}

interface StagedItem extends GenProblem {
  id: string;
  proof?: string;
  toolchain?: string;
  createdAt?: string;
}

interface Health {
  staging: { ok: boolean; length?: number; error?: string };
  prod: { ok: boolean; length?: number; error?: string };
}

function extractJson(text: string): GenProblem | null {
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    return JSON.parse(m[0]);
  } catch {
    return null;
  }
}

export function AdminPanel({ className }: { className?: string }) {
  const { data: session } = useSession();
  const isAdmin = isAdminEmail(session?.user?.email);

  const [open, setOpen] = useState(false);
  const [work, setWork] = useState(false);
  const [stage, setStage] = useState<
    'idle' | 'generating' | 'proving' | 'queuing'
  >('idle');
  const [current, setCurrent] = useState<GenProblem | null>(null);
  const [activity, setActivity] = useState<Array<{ id: number; tool: string }>>(
    [],
  );
  const [stats, setStats] = useState({
    generated: 0,
    verified: 0,
    discarded: 0,
    errors: 0,
  });
  const [queued, setQueued] = useState<number | null>(null);
  const [health, setHealth] = useState<Health | null>(null);
  const [items, setItems] = useState<StagedItem[]>([]);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const workRef = useRef(false);

  // Load the queue: Redis health for both instances + the staged items.
  const loadQueue = useCallback(async () => {
    try {
      const r = await fetch('/api/admin/problems');
      if (!r.ok) return;
      const j = await r.json();
      setHealth(j.health ?? null);
      setItems(Array.isArray(j.items) ? j.items : []);
      setQueued(j.queued ?? null);
    } catch {
      /* ignore */
    }
  }, []);

  const removeItem = useCallback(
    async (id: string) => {
      setBusy(id);
      try {
        await fetch(`/api/admin/problems?id=${encodeURIComponent(id)}`, {
          method: 'DELETE',
        });
        await loadQueue();
      } finally {
        setBusy(null);
      }
    },
    [loadQueue],
  );

  const promoteItem = useCallback(
    async (id: string) => {
      setBusy(id);
      try {
        const r = await fetch('/api/admin/problems/promote', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ id }),
        });
        if (!r.ok) {
          const detail = await r.text();
          throw new Error(detail || `promote failed (${r.status})`);
        }
        await loadQueue();
      } catch (e) {
        setHealth((h) =>
          h
            ? { ...h, prod: { ok: false, error: String((e as Error).message) } }
            : h,
        );
      } finally {
        setBusy(null);
      }
    },
    [loadQueue],
  );

  const getConn = () => {
    try {
      return JSON.parse(localStorage.getItem('lca.connection') || '{}');
    } catch {
      return {};
    }
  };

  const callBridge = useCallback((path: string, init?: RequestInit) => {
    const conn = getConn();
    const base = (conn.bridgeUrl || 'http://localhost:4123').replace(/\/$/, '');
    return fetch(`${base}${path}`, {
      ...init,
      headers: {
        'content-type': 'application/json',
        'x-bridge-token': conn.token || '',
        ...(init?.headers || {}),
      },
    });
  }, []);

  const fetchMcp = async (): Promise<Array<{ name: string; url: string }>> => {
    try {
      const r = await fetch('/api/mcp/servers');
      if (!r.ok) return [];
      const s = await r.json();
      return Array.isArray(s)
        ? s
            .filter((x: any) => x?.url && x?.name && x?.isActive !== false)
            .map((x: any) => ({ name: x.name, url: x.url }))
        : [];
    } catch {
      return [];
    }
  };

  // Prove via the bridge stream; collect a little activity, return the outcome.
  const proveStream = useCallback(
    async (lean: string, mcpServers: Array<{ name: string; url: string }>) => {
      const res = await callBridge('/prove-stream', {
        method: 'POST',
        body: JSON.stringify({ theorem: lean, mcpServers }),
      });
      if (!res.ok || !res.body) return { verified: false, proof: '' };
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      let outcome = { verified: false, proof: '' };
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const events = buf.split('\n\n');
        buf = events.pop() || '';
        for (const e of events) {
          if (!e.startsWith('data:')) continue;
          try {
            const d = JSON.parse(e.replace(/^data:\s*/, ''));
            if (d.type === 'message-annotation' && d.tool) {
              setActivity((a) => [
                ...a.slice(-7),
                { id: Date.now() + a.length, tool: String(d.tool) },
              ]);
            }
            if (d.type === 'done')
              outcome = { verified: !!d.verified, proof: d.proof || '' };
          } catch {
            /* ignore */
          }
        }
      }
      return outcome;
    },
    [callBridge],
  );

  const runOnce = useCallback(async () => {
    const mcpServers = await fetchMcp();

    setStage('generating');
    setActivity([]);
    setCurrent(null);
    const genRes = await callBridge('/run', {
      method: 'POST',
      body: JSON.stringify({
        prompt: GEN_PROMPT,
        options: { timeoutMs: 180000 },
      }),
    });
    if (!genRes.ok) throw new Error(`generation failed (${genRes.status})`);
    const genData = await genRes.json();
    const gen = extractJson(genData.text || genData.proof || '');
    if (!gen?.lean) throw new Error('could not parse generated problem');
    setStats((s) => ({ ...s, generated: s.generated + 1 }));
    setCurrent(gen);

    setStage('proving');
    const { verified, proof } = await proveStream(gen.lean, mcpServers);

    if (verified) {
      setStage('queuing');
      const r = await fetch('/api/admin/problems', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...gen, proof, toolchain: TOOLCHAIN }),
      });
      if (r.ok) {
        const j = await r.json();
        setQueued(j.queued);
        setStats((s) => ({ ...s, verified: s.verified + 1 }));
        loadQueue();
      }
    } else {
      setStats((s) => ({ ...s, discarded: s.discarded + 1 }));
    }
  }, [callBridge, proveStream, loadQueue]);

  // Refresh the queue view whenever the dropdown is opened.
  useEffect(() => {
    if (open) loadQueue();
  }, [open, loadQueue]);

  useEffect(() => {
    workRef.current = work;
    if (!work) {
      setStage('idle');
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch('/api/admin/problems');
        if (r.ok) setQueued((await r.json()).queued);
      } catch {
        /* ignore */
      }
      while (!cancelled && workRef.current) {
        try {
          await runOnce();
        } catch {
          setStats((s) => ({ ...s, errors: s.errors + 1 }));
          await new Promise((r) => setTimeout(r, 3000));
        }
      }
      if (!cancelled) setStage('idle');
    })();
    return () => {
      cancelled = true;
    };
  }, [work, runOnce]);

  if (!isAdmin) return null;

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          className={cn('h-[34px]', className)}
        >
          {work ? (
            <span className="flex items-center gap-1.5">
              <span className="h-2 w-2 animate-pulse rounded-full bg-emerald-500" />
              Admin · {stats.verified} queued
            </span>
          ) : (
            'Admin'
          )}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        className="max-h-[80vh] w-[420px] overflow-y-auto p-3"
      >
        <DropdownMenuLabel className="px-0">Content pipeline</DropdownMenuLabel>

        <div className="mt-1 flex items-center justify-between rounded-md border p-3">
          <div>
            <Label htmlFor="admin-work">Work</Label>
            <p className="text-xs text-muted-foreground">
              Generate creative problems → prove in Lean → queue the verified
              ones.
            </p>
          </div>
          <Switch id="admin-work" checked={work} onCheckedChange={setWork} />
        </div>

        <div className="mt-3 grid grid-cols-4 gap-2 text-center text-xs">
          <Stat label="Generated" value={stats.generated} />
          <Stat
            label="Verified"
            value={stats.verified}
            tone="text-emerald-600"
          />
          <Stat label="Discarded" value={stats.discarded} />
          <Stat label="Queued" value={queued ?? '—'} />
        </div>

        <Separator className="my-3" />

        <div className="text-xs">
          <div className="flex items-center gap-2">
            <span className="font-medium">Status:</span>
            <span className="capitalize text-muted-foreground">{stage}</span>
            {stats.errors > 0 && (
              <span className="text-red-500">· {stats.errors} errors</span>
            )}
          </div>

          {current?.problem && (
            <div className="mt-2 max-h-24 overflow-y-auto rounded bg-muted/40 p-2 leading-snug">
              <p className="font-medium text-foreground">Current problem</p>
              <p className="text-muted-foreground">{current.problem}</p>
              {current.answer !== undefined && (
                <p className="mt-1 text-muted-foreground">
                  Answer: {String(current.answer)}
                </p>
              )}
            </div>
          )}

          {activity.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1">
              {activity.map((t) => (
                <span
                  key={t.id}
                  className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground"
                >
                  {t.tool}
                </span>
              ))}
            </div>
          )}
        </div>

        <Separator className="my-3" />

        {/* Queue management */}
        <div className="flex items-center justify-between">
          <span className="text-xs font-medium">
            Review queue{' '}
            {health?.staging.ok && (
              <span className="text-muted-foreground">
                ({health.staging.length ?? items.length})
              </span>
            )}
          </span>
          <button
            type="button"
            onClick={loadQueue}
            className="text-[11px] text-muted-foreground underline-offset-2 hover:underline"
          >
            Refresh
          </button>
        </div>

        <div className="mt-2 flex gap-2 text-[11px]">
          <HealthChip label="Staging" state={health?.staging} />
          <HealthChip label="Prod" state={health?.prod} />
        </div>

        <div className="mt-2 space-y-1.5">
          {items.length === 0 && (
            <p className="text-[11px] text-muted-foreground">
              {health && !health.staging.ok
                ? 'Staging Redis unreachable — see error above.'
                : 'Queue is empty.'}
            </p>
          )}
          {items.map((it) => (
            <div key={it.id} className="rounded-md border p-2 text-xs">
              <div className="flex items-start justify-between gap-2">
                <button
                  type="button"
                  onClick={() =>
                    setExpanded((e) => (e === it.id ? null : it.id))
                  }
                  className="min-w-0 flex-1 text-left"
                >
                  <span className="block truncate font-medium">
                    {it.questionTitle || it.problem || 'Untitled problem'}
                  </span>
                  <span className="text-[10px] text-muted-foreground">
                    {[
                      it.difficulty,
                      it.points ? `${it.points}pts` : null,
                      it.answer != null ? `ans ${it.answer}` : null,
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  </span>
                </button>
                <div className="flex shrink-0 gap-1">
                  <Button
                    size="sm"
                    variant="secondary"
                    className="h-6 px-2 text-[11px]"
                    disabled={busy === it.id || !health?.prod.ok}
                    onClick={() => promoteItem(it.id)}
                    title={
                      health?.prod.ok
                        ? 'Push to production weekly-problems queue'
                        : 'Prod Redis unreachable'
                    }
                  >
                    {busy === it.id ? '…' : 'Push to prod'}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-6 px-2 text-[11px] text-red-500 hover:text-red-600"
                    disabled={busy === it.id}
                    onClick={() => removeItem(it.id)}
                  >
                    Delete
                  </Button>
                </div>
              </div>

              {expanded === it.id && (
                <div className="mt-2 space-y-1 border-t pt-2 text-[11px] text-muted-foreground">
                  {it.problem && <p>{it.problem}</p>}
                  {it.insight && (
                    <p>
                      <span className="font-medium text-foreground">
                        Insight:{' '}
                      </span>
                      {it.insight}
                    </p>
                  )}
                  {it.lean && (
                    <pre className="overflow-x-auto whitespace-pre-wrap rounded bg-muted/50 p-1.5 text-[10px] text-foreground">
                      {it.lean}
                    </pre>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>

        <p className="mt-3 text-[11px] text-muted-foreground">
          Requires your bridge running (Local Agent → set it up). Verified
          problems land in the staging queue; “Push to prod” publishes to the
          main CompeteMath queue and archives the Lean proof to the database.
        </p>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function Stat({
  label,
  value,
  tone,
}: { label: string; value: number | string; tone?: string }) {
  return (
    <div className="rounded-md border p-1.5">
      <div className={cn('text-sm font-semibold', tone)}>{value}</div>
      <div className="text-[10px] text-muted-foreground">{label}</div>
    </div>
  );
}

function HealthChip({
  label,
  state,
}: {
  label: string;
  state?: { ok: boolean; length?: number; error?: string };
}) {
  const ok = state?.ok;
  return (
    <span
      className={cn(
        'flex items-center gap-1 rounded border px-1.5 py-0.5',
        ok === undefined
          ? 'text-muted-foreground'
          : ok
            ? 'border-emerald-500/40 text-emerald-600'
            : 'border-red-500/40 text-red-500',
      )}
      title={state?.error || undefined}
    >
      <span
        className={cn(
          'h-1.5 w-1.5 rounded-full',
          ok === undefined
            ? 'bg-muted-foreground'
            : ok
              ? 'bg-emerald-500'
              : 'bg-red-500',
        )}
      />
      {label}
      {ok && state?.length != null ? ` · ${state.length}` : ''}
      {ok === false ? ' · error' : ''}
    </span>
  );
}
