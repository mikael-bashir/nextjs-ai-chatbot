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

Respond with ONLY this JSON object, nothing else:
{"problem":"<self-contained statement>","answer":<integer>,"insight":"<key trick, 1-2 sentences>","lean":"theorem name : <statement encoding the integer answer> := by sorry"}`;

const TOOLCHAIN = 'leanprover/lean4:v4.29.1';

interface GenProblem {
  problem?: string;
  answer?: number;
  insight?: string;
  lean?: string;
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

  const workRef = useRef(false);

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
      }
    } else {
      setStats((s) => ({ ...s, discarded: s.discarded + 1 }));
    }
  }, [callBridge, proveStream]);

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
      <DropdownMenuContent align="end" className="w-96 p-3">
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

        <p className="mt-3 text-[11px] text-muted-foreground">
          Requires your bridge running (Local Agent → set it up). Verified
          problems are pushed to the Redis queue.
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
