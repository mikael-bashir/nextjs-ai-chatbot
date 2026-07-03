'use client';

import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Separator } from '@/components/ui/separator';
import { cn } from '@/lib/utils';
import { MathMarkdown } from '@/components/math-markdown';

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

interface GeneratedItem extends StagedItem {
  verified: boolean;
  error?: string | null;
}

interface Health {
  staging: { ok: boolean; length?: number; error?: string };
  prod: { ok: boolean; length?: number; error?: string };
}

type GenFilter = 'all' | 'verified' | 'failed';

function extractJson(text: string): GenProblem | null {
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    return JSON.parse(m[0]);
  } catch {
    return null;
  }
}

function metaLine(p: GeneratedItem | StagedItem, withDate = false): string {
  return [
    p.difficulty,
    p.points ? `${p.points}pts` : null,
    p.answer != null ? `ans ${p.answer}` : null,
    withDate && (p as GeneratedItem).createdAt
      ? new Date((p as GeneratedItem).createdAt as string).toLocaleString()
      : null,
  ]
    .filter(Boolean)
    .join(' · ');
}

export function AdminPipeline() {
  const [work, setWork] = useState(false);
  const [stage, setStage] = useState<
    'idle' | 'generating' | 'proving' | 'saving'
  >('idle');
  const [current, setCurrent] = useState<GenProblem | null>(null);
  const [activity, setActivity] = useState<Array<{ id: number; tool: string }>>(
    [],
  );
  const [stats, setStats] = useState({
    generated: 0,
    verified: 0,
    failed: 0,
    errors: 0,
  });
  const [queued, setQueued] = useState<number | null>(null);
  const [health, setHealth] = useState<Health | null>(null);
  const [items, setItems] = useState<StagedItem[]>([]);
  const [generated, setGenerated] = useState<GeneratedItem[]>([]);
  const [genCap, setGenCap] = useState(200);
  const [genFilter, setGenFilter] = useState<GenFilter>('all');
  const [previewId, setPreviewId] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [workBridgeUrl, setWorkBridgeUrl] = useState('');
  const [lastError, setLastError] = useState<string | null>(null);

  const workRef = useRef(false);

  const getConn = () => {
    try {
      const base = JSON.parse(localStorage.getItem('lca.connection') || '{}');
      const workUrl = localStorage.getItem('lca.workBridgeUrl') || '';
      return workUrl ? { ...base, bridgeUrl: workUrl } : base;
    } catch {
      return {};
    }
  };

  const callBridge = useCallback((path: string, init?: RequestInit) => {
    const conn = getConn();
    let base = (conn.bridgeUrl || 'http://localhost:4123').replace(/\/$/, '');
    // Tolerate a bare host:port (e.g. "localhost:4123") — fetch needs a scheme.
    if (!/^https?:\/\//i.test(base)) base = `http://${base}`;
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
                ...a.slice(-9),
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

  const loadGenerated = useCallback(async () => {
    try {
      const r = await fetch('/api/admin/generated');
      if (!r.ok) return;
      const j = await r.json();
      setGenerated(Array.isArray(j.items) ? j.items : []);
      if (typeof j.cap === 'number') setGenCap(j.cap);
    } catch {
      /* ignore */
    }
  }, []);

  const loadAll = useCallback(() => {
    loadQueue();
    loadGenerated();
  }, [loadQueue, loadGenerated]);

  useEffect(() => {
    loadAll();
    setWorkBridgeUrl(localStorage.getItem('lca.workBridgeUrl') || '');
  }, [loadAll]);

  const persistWorkBridgeUrl = (value: string) => {
    setWorkBridgeUrl(value);
    if (value.trim()) localStorage.setItem('lca.workBridgeUrl', value.trim());
    else localStorage.removeItem('lca.workBridgeUrl');
  };

  // ---- per-item actions -------------------------------------------------

  // Re-run the Lean proof for a stored problem and persist the new outcome.
  // Deliberately does NOT push to staging — that's a separate manual action.
  const verifyAgain = useCallback(
    async (item: GeneratedItem) => {
      if (!item.lean) return;
      setBusy(`verify:${item.id}`);
      setActivity([]);
      try {
        const mcpServers = await fetchMcp();
        let verified = false;
        let proof = '';
        let error: string | null = null;
        try {
          const out = await proveStream(item.lean, mcpServers);
          verified = out.verified;
          proof = out.proof;
          if (!verified) error = 'Lean proof did not verify';
        } catch (e) {
          error = String((e as Error)?.message || e);
        }
        await fetch('/api/admin/generated', {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ id: item.id, verified, proof, error }),
        });
        await loadGenerated();
      } finally {
        setBusy(null);
      }
    },
    [proveStream, loadGenerated],
  );

  // Manually add a problem to the staging review queue (deliberate action).
  const addToStaging = useCallback(
    async (item: GeneratedItem | StagedItem) => {
      if (!item.lean) return;
      setBusy(`stage:${item.id}`);
      try {
        await fetch('/api/admin/problems', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            questionTitle: item.questionTitle ?? null,
            subtitle: item.subtitle ?? null,
            problem: item.problem ?? null,
            answer: item.answer ?? null,
            difficulty: item.difficulty ?? null,
            points: item.points ?? null,
            insight: item.insight ?? null,
            lean: item.lean,
            proof: item.proof ?? '',
            toolchain: item.toolchain ?? TOOLCHAIN,
          }),
        });
        await loadQueue();
      } finally {
        setBusy(null);
      }
    },
    [loadQueue],
  );

  const removeGenerated = useCallback(
    async (id: string) => {
      setBusy(`del:${id}`);
      try {
        await fetch(`/api/admin/generated?id=${encodeURIComponent(id)}`, {
          method: 'DELETE',
        });
        await loadGenerated();
      } finally {
        setBusy(null);
      }
    },
    [loadGenerated],
  );

  const removeItem = useCallback(
    async (id: string) => {
      setBusy(`del:${id}`);
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
      setBusy(`promote:${id}`);
      try {
        const r = await fetch('/api/admin/problems/promote', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ id }),
        });
        if (!r.ok) throw new Error((await r.text()) || `failed (${r.status})`);
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

  // ---- the Work loop ----------------------------------------------------

  const runOnce = useCallback(async () => {
    const bridgeUrl =
      (getConn().bridgeUrl as string) || 'http://localhost:4123';
    const mcpServers = await fetchMcp();
    setStage('generating');
    setActivity([]);
    setCurrent(null);
    setLastError(null);

    let genRes: Response;
    try {
      genRes = await callBridge('/run', {
        method: 'POST',
        body: JSON.stringify({
          prompt: GEN_PROMPT,
          options: { timeoutMs: 180000 },
        }),
      });
    } catch {
      // A failed fetch to the bridge is opaque (TypeError). Point at the URL.
      throw new Error(
        `Couldn't reach the bridge at ${bridgeUrl}. Check: a bridge is running on that port, the URL is a full http:// URL (not just "localhost:4123"), and you're on Chrome/Edge/Firefox (Safari blocks HTTPS→localhost).`,
      );
    }
    if (!genRes.ok) {
      const detail = await genRes.text().catch(() => '');
      throw new Error(
        `Bridge /run failed (${genRes.status})${detail ? `: ${detail.slice(0, 200)}` : ''}`,
      );
    }
    const genData = await genRes.json();
    const raw = String(genData.text || genData.proof || '');
    const gen = extractJson(raw);
    if (!gen?.lean) {
      throw new Error(
        `Couldn't parse a problem from the generation output${
          raw ? `: ${raw.slice(0, 160)}…` : ' (empty response)'
        }`,
      );
    }
    setStats((s) => ({ ...s, generated: s.generated + 1 }));
    setCurrent(gen);

    setStage('proving');
    let verified = false;
    let proof = '';
    let proveError: string | null = null;
    try {
      const out = await proveStream(gen.lean, mcpServers);
      verified = out.verified;
      proof = out.proof;
      if (!verified) proveError = 'Lean proof did not verify';
    } catch (e) {
      proveError = String((e as Error)?.message || e);
    }

    setStage('saving');
    const r = await fetch('/api/admin/generated', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        ...gen,
        verified,
        proof,
        error: proveError,
        toolchain: TOOLCHAIN,
      }),
    });
    if (r.ok) {
      const j = await r.json();
      if (typeof j.queued === 'number') setQueued(j.queued);
    }
    setStats((s) => ({
      ...s,
      verified: s.verified + (verified ? 1 : 0),
      failed: s.failed + (verified ? 0 : 1),
    }));
    loadAll();
  }, [callBridge, proveStream, loadAll]);

  useEffect(() => {
    workRef.current = work;
    if (!work) {
      setStage('idle');
      return;
    }
    let cancelled = false;
    (async () => {
      while (!cancelled && workRef.current) {
        try {
          await runOnce();
        } catch (e) {
          setStats((s) => ({ ...s, errors: s.errors + 1 }));
          setLastError(String((e as Error)?.message || e));
          await new Promise((res) => setTimeout(res, 3000));
        }
      }
      if (!cancelled) setStage('idle');
    })();
    return () => {
      cancelled = true;
    };
  }, [work, runOnce]);

  const filtered = generated.filter(
    (g) =>
      genFilter === 'all' ||
      (genFilter === 'verified' ? g.verified : !g.verified),
  );

  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-8">
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Content pipeline</h1>
          <p className="text-sm text-muted-foreground">
            Generate creative problems, prove them in Lean, review, and publish.
          </p>
        </div>
        <Button asChild variant="ghost" size="sm">
          <Link href="/">← Back to chat</Link>
        </Button>
      </div>

      {/* Work control */}
      <div className="rounded-lg border p-4">
        <div className="flex items-center justify-between">
          <div>
            <Label htmlFor="admin-work" className="text-base">
              Work
            </Label>
            <p className="text-xs text-muted-foreground">
              While on: generate → prove in Lean → keep every one. Verified
              problems also enter the review queue automatically.
            </p>
          </div>
          <Switch id="admin-work" checked={work} onCheckedChange={setWork} />
        </div>

        <div className="mt-3">
          <Label htmlFor="admin-work-bridge" className="text-xs">
            Work bridge URL (optional)
          </Label>
          <Input
            id="admin-work-bridge"
            value={workBridgeUrl}
            placeholder="defaults to your shared bridge"
            className="mt-1 h-8 max-w-sm text-xs"
            onChange={(e) => persistWorkBridgeUrl(e.target.value)}
          />
          <p className="mt-1 text-[11px] text-muted-foreground">
            Point the Work loop at its own bridge (e.g. http://localhost:4124),
            separate from chat/manual verification. Uses the same token.
          </p>
        </div>

        <div className="mt-4 grid grid-cols-4 gap-2 text-center">
          <Stat label="Generated" value={stats.generated} />
          <Stat
            label="Verified"
            value={stats.verified}
            tone="text-emerald-600"
          />
          <Stat label="Failed" value={stats.failed} />
          <Stat label="Queued" value={queued ?? '—'} />
        </div>

        <div className="mt-3 flex items-center gap-2 text-xs">
          <span className="font-medium">Status:</span>
          <span className="capitalize text-muted-foreground">{stage}</span>
          {stats.errors > 0 && (
            <span className="text-red-500">· {stats.errors} loop errors</span>
          )}
          {activity.length > 0 && (
            <div className="flex flex-wrap gap-1">
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
        {current?.questionTitle && (
          <p className="mt-2 text-xs text-muted-foreground">
            Current: {current.questionTitle}
          </p>
        )}
        {lastError && (
          <div className="mt-2 rounded-md border border-red-500/40 bg-red-500/5 p-2 text-xs text-red-500">
            <span className="font-medium">Last error: </span>
            <span className="break-all font-mono">{lastError}</span>
          </div>
        )}
      </div>

      {/* Generated history */}
      <div className="mt-8">
        <div className="mb-2 flex items-center justify-between">
          <h2 className="text-lg font-semibold">
            Generated{' '}
            <span className="text-sm font-normal text-muted-foreground">
              ({generated.length}/{genCap})
            </span>
          </h2>
          <div className="flex items-center gap-1 text-xs">
            {(['all', 'verified', 'failed'] as GenFilter[]).map((f) => (
              <button
                key={f}
                type="button"
                onClick={() => setGenFilter(f)}
                className={cn(
                  'rounded px-2 py-1 capitalize',
                  genFilter === f
                    ? 'bg-muted font-medium text-foreground'
                    : 'text-muted-foreground hover:text-foreground',
                )}
              >
                {f}
              </button>
            ))}
            <button
              type="button"
              onClick={loadGenerated}
              className="ml-1 text-muted-foreground underline-offset-2 hover:underline"
            >
              Refresh
            </button>
          </div>
        </div>

        <div className="space-y-2">
          {filtered.length === 0 && (
            <p className="text-sm text-muted-foreground">
              No {genFilter === 'all' ? '' : `${genFilter} `}problems yet.
            </p>
          )}
          {filtered.map((g) => (
            <div key={g.id} className="rounded-lg border p-3">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span
                      className={cn(
                        'shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium uppercase',
                        g.verified
                          ? 'bg-emerald-500/15 text-emerald-600'
                          : 'bg-red-500/15 text-red-500',
                      )}
                    >
                      {g.verified ? 'proved' : 'failed'}
                    </span>
                    <span className="truncate font-medium">
                      {g.questionTitle || g.problem || 'Untitled problem'}
                    </span>
                  </div>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    {metaLine(g, true)}
                  </p>
                </div>
              </div>

              <div className="mt-2 flex flex-wrap gap-1.5">
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 px-2 text-xs"
                  onClick={() =>
                    setPreviewId((p) => (p === g.id ? null : g.id))
                  }
                >
                  {previewId === g.id ? 'Hide preview' : 'Preview'}
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 px-2 text-xs"
                  disabled={busy === `verify:${g.id}`}
                  onClick={() => verifyAgain(g)}
                >
                  {busy === `verify:${g.id}` ? 'Verifying…' : 'Verify again'}
                </Button>
                <Button
                  size="sm"
                  variant="secondary"
                  className="h-7 px-2 text-xs"
                  disabled={busy === `stage:${g.id}`}
                  onClick={() => addToStaging(g)}
                  title="Add this problem to the staging review queue"
                >
                  {busy === `stage:${g.id}` ? 'Adding…' : 'Add to staging'}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7 px-2 text-xs text-red-500 hover:text-red-600"
                  disabled={busy === `del:${g.id}`}
                  onClick={() => removeGenerated(g.id)}
                >
                  Delete
                </Button>
              </div>

              {previewId === g.id && (
                <div className="mt-3 space-y-3 border-t pt-3">
                  {g.problem && <MathMarkdown>{g.problem}</MathMarkdown>}
                  {g.insight && (
                    <div className="rounded bg-muted/40 p-2 text-xs">
                      <span className="font-medium">Insight. </span>
                      <MathMarkdown>{g.insight}</MathMarkdown>
                    </div>
                  )}
                  {!g.verified && g.error && (
                    <p className="text-xs text-red-500">Reason: {g.error}</p>
                  )}
                  {g.lean && (
                    <pre className="overflow-x-auto whitespace-pre-wrap rounded bg-muted/50 p-2 text-[11px]">
                      {g.lean}
                    </pre>
                  )}
                  {g.verified && g.proof && (
                    <pre className="overflow-x-auto whitespace-pre-wrap rounded bg-emerald-500/10 p-2 text-[11px]">
                      {g.proof}
                    </pre>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      </div>

      <Separator className="my-8" />

      {/* Review queue */}
      <div>
        <div className="mb-2 flex items-center justify-between">
          <h2 className="text-lg font-semibold">
            Review queue{' '}
            <span className="text-sm font-normal text-muted-foreground">
              ({health?.staging.length ?? items.length})
            </span>
          </h2>
          <div className="flex items-center gap-2 text-xs">
            <HealthChip label="Staging" state={health?.staging} />
            <HealthChip label="Prod" state={health?.prod} />
            <button
              type="button"
              onClick={loadQueue}
              className="text-muted-foreground underline-offset-2 hover:underline"
            >
              Refresh
            </button>
          </div>
        </div>

        {(health?.staging.error || health?.prod.error) && (
          <div className="mb-2 space-y-1 rounded-md border border-red-500/40 bg-red-500/5 p-2 text-[11px] text-red-500">
            {health?.staging.error && (
              <p>
                <span className="font-medium">Staging: </span>
                <span className="break-all font-mono">
                  {health.staging.error}
                </span>
              </p>
            )}
            {health?.prod.error && (
              <p>
                <span className="font-medium">Prod: </span>
                <span className="break-all font-mono">{health.prod.error}</span>
              </p>
            )}
          </div>
        )}

        <div className="space-y-2">
          {items.length === 0 && (
            <p className="text-sm text-muted-foreground">
              {health && !health.staging.ok
                ? 'Staging Redis unreachable — see the error above.'
                : 'Queue is empty.'}
            </p>
          )}
          {items.map((it) => (
            <div key={it.id} className="rounded-lg border p-3">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0 flex-1">
                  <p className="truncate font-medium">
                    {it.questionTitle || it.problem || 'Untitled problem'}
                  </p>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    {metaLine(it)}
                  </p>
                </div>
                <div className="flex shrink-0 gap-1.5">
                  <Button
                    size="sm"
                    variant="secondary"
                    className="h-7 px-2 text-xs"
                    disabled={busy === `promote:${it.id}` || !health?.prod.ok}
                    onClick={() => promoteItem(it.id)}
                    title={
                      health?.prod.ok
                        ? 'Publish to the production weekly-problems queue'
                        : 'Prod Redis unreachable'
                    }
                  >
                    {busy === `promote:${it.id}` ? '…' : 'Push to prod'}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-7 px-2 text-xs text-red-500 hover:text-red-600"
                    disabled={busy === `del:${it.id}`}
                    onClick={() => removeItem(it.id)}
                  >
                    Delete
                  </Button>
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>

      <p className="mt-8 text-xs text-muted-foreground">
        Requires your bridge running (Local Agent → set it up). “Add to staging”
        and “Verify again” are manual — re-verifying never auto-stages. “Push to
        prod” publishes to the main CompeteMath queue and archives the Lean
        proof to the database.
      </p>
    </div>
  );
}

function Stat({
  label,
  value,
  tone,
}: {
  label: string;
  value: number | string;
  tone?: string;
}) {
  return (
    <div className="rounded-md border p-2">
      <div className={cn('text-lg font-semibold', tone)}>{value}</div>
      <div className="text-[11px] text-muted-foreground">{label}</div>
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
          'size-1.5 rounded-full',
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
