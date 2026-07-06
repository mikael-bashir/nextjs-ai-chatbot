'use client';

import { useCallback, useMemo, useState } from 'react';
import Link from 'next/link';
import {
  Copy,
  Check,
  KeyRound,
  Loader2,
  Play,
  Trash2,
  Zap,
  ShieldCheck,
  RotateCw,
} from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';

interface KeyView {
  id: string;
  name: string;
  prefix: string;
  lastUsedAt: string | null;
  createdAt: string;
}

const SAMPLE_PROBLEM =
  'Prove that for every natural number n, 1 + 2 + ... + n = n(n+1)/2.';

function CopyButton({ value, label }: { value: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      className="h-7 gap-1.5 px-2 text-xs"
      onClick={() => {
        navigator.clipboard.writeText(value);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }}
    >
      {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
      {label ?? (copied ? 'Copied' : 'Copy')}
    </Button>
  );
}

export function DashboardClient({
  initialKeys,
  balance,
  userName,
  isAdmin = false,
}: {
  initialKeys: KeyView[];
  balance: number;
  userName: string;
  isAdmin?: boolean;
}) {
  const [keys, setKeys] = useState<KeyView[]>(initialKeys);
  const [newName, setNewName] = useState('');
  const [creating, setCreating] = useState(false);
  // Plaintext of the most recently created key — shown once, kept in memory so
  // the tester below can use it immediately. Never re-fetchable.
  const [freshKey, setFreshKey] = useState<string | null>(null);

  // Tester state.
  const [testKey, setTestKey] = useState('');
  const [problem, setProblem] = useState(SAMPLE_PROBLEM);
  const [mockMode, setMockMode] = useState(true);
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  // For real (queued) jobs, remember the id so it can be polled.
  const [lastJobId, setLastJobId] = useState<string | null>(null);
  const [polling, setPolling] = useState(false);

  const origin = typeof window !== 'undefined' ? window.location.origin : '';

  const createKey = useCallback(async () => {
    setCreating(true);
    try {
      const res = await fetch('/api/keys', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: newName.trim() || 'default' }),
      });
      const data = await res.json();
      if (res.ok) {
        setFreshKey(data.key);
        setTestKey(data.key); // auto-fill the tester
        setKeys((prev) => [
          {
            id: data.id,
            name: data.name,
            prefix: data.prefix,
            lastUsedAt: null,
            createdAt: data.createdAt,
          },
          ...prev,
        ]);
        setNewName('');
      }
    } finally {
      setCreating(false);
    }
  }, [newName]);

  const revokeKey = useCallback(async (id: string) => {
    const res = await fetch(`/api/keys/${id}`, { method: 'DELETE' });
    if (res.ok) setKeys((prev) => prev.filter((k) => k.id !== id));
  }, []);

  const runTest = useCallback(async () => {
    setTesting(true);
    setResult(null);
    setLastJobId(null);
    try {
      const res = await fetch('/api/v1/problems', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${testKey.trim()}`,
        },
        body: JSON.stringify({ problem, mock: mockMode }),
      });
      const data = await res.json();
      setResult(JSON.stringify(data, null, 2));
      // Real jobs come back "queued" — keep the id so it can be polled.
      if (!mockMode && data?.id && data?.status === 'queued') {
        setLastJobId(data.id);
      }
    } catch (e) {
      setResult(String(e));
    } finally {
      setTesting(false);
    }
  }, [testKey, problem, mockMode]);

  const pollStatus = useCallback(async () => {
    if (!lastJobId) return;
    setPolling(true);
    try {
      const res = await fetch(`/api/v1/problems/${lastJobId}`, {
        headers: { authorization: `Bearer ${testKey.trim()}` },
      });
      const data = await res.json();
      setResult(JSON.stringify(data, null, 2));
    } finally {
      setPolling(false);
    }
  }, [lastJobId, testKey]);

  const curl = useMemo(() => {
    const key = testKey.trim() || 'leak_sk_…';
    const bodyObj = mockMode
      ? `{"problem": ${JSON.stringify(problem)}, "mock": true}`
      : `{"problem": ${JSON.stringify(problem)}}`;
    return `curl ${origin}/api/v1/problems \\
  -H "Authorization: Bearer ${key}" \\
  -H "Content-Type: application/json" \\
  -d '${bodyObj}'`;
  }, [origin, testKey, problem, mockMode]);

  return (
    <div className="mx-auto max-w-3xl px-6 py-16">
      {/* Header */}
      <div className="mb-12">
        <p className="font-mono text-xs uppercase tracking-[0.25em] text-muted-foreground">
          Leak API
        </p>
        <h1 className="mt-2 text-3xl font-semibold tracking-tight">
          Welcome, {userName}
        </h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Create a key, then prove your first problem in three steps. You pay
          only when a proof succeeds.
        </p>
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <div className="inline-flex items-center gap-2 rounded-full border px-3 py-1">
            <Zap className="size-3.5 text-amber-500" />
            <span className="font-mono text-sm tabular-nums">
              {balance.toFixed(2)} credits
            </span>
            <span className="text-xs text-muted-foreground">
              (£{balance.toFixed(2)})
            </span>
          </div>
          {isAdmin && (
            <Link
              href="/admin"
              className="inline-flex items-center gap-1.5 rounded-full border border-amber-500/40 bg-amber-500/10 px-3 py-1 text-xs font-medium text-amber-600 transition-colors hover:bg-amber-500/20 dark:text-amber-400"
            >
              <ShieldCheck className="size-3.5" />
              Admin · prover console
            </Link>
          )}
        </div>
      </div>

      {/* Step 1 — API keys */}
      <section className="mb-12">
        <div className="mb-4 flex items-center gap-2">
          <KeyRound className="size-4" />
          <h2 className="text-sm font-semibold uppercase tracking-wide">
            1 · API keys
          </h2>
        </div>

        {freshKey && (
          <div className="mb-4 rounded-lg border border-amber-500/40 bg-amber-500/10 p-4">
            <p className="text-xs font-medium text-amber-600 dark:text-amber-400">
              Copy this key now — it won&apos;t be shown again.
            </p>
            <div className="mt-2 flex items-center gap-2">
              <code className="flex-1 overflow-x-auto rounded bg-background/60 px-3 py-2 font-mono text-sm">
                {freshKey}
              </code>
              <CopyButton value={freshKey} />
            </div>
          </div>
        )}

        <div className="mb-4 flex gap-2">
          <Input
            placeholder="Key name (e.g. production)"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            className="font-mono text-sm"
          />
          <Button onClick={createKey} disabled={creating} className="gap-2">
            {creating ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <KeyRound className="size-4" />
            )}
            Create key
          </Button>
        </div>

        {keys.length === 0 ? (
          <p className="rounded-lg border border-dashed px-4 py-6 text-center text-sm text-muted-foreground">
            No keys yet. Create one to start.
          </p>
        ) : (
          <ul className="divide-y rounded-lg border">
            {keys.map((k) => (
              <li key={k.id} className="flex items-center gap-3 px-4 py-3">
                <code className="font-mono text-sm">{k.prefix}</code>
                <Badge variant="secondary" className="font-normal">
                  {k.name}
                </Badge>
                <span className="ml-auto text-xs text-muted-foreground">
                  {k.lastUsedAt
                    ? `used ${new Date(k.lastUsedAt).toLocaleDateString()}`
                    : 'never used'}
                </span>
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-7 text-muted-foreground hover:text-destructive"
                  onClick={() => revokeKey(k.id)}
                  aria-label="Revoke key"
                >
                  <Trash2 className="size-4" />
                </Button>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* Step 2 — Test the API */}
      <section>
        <div className="mb-4 flex items-center gap-2">
          <Play className="size-4" />
          <h2 className="text-sm font-semibold uppercase tracking-wide">
            2 · Test the API
          </h2>
        </div>
        <p className="mb-4 text-sm text-muted-foreground">
          <strong className="font-medium text-foreground">Mock</strong> returns a
          canned proof instantly — no credits spent. Turn it off to send a{' '}
          <strong className="font-medium text-foreground">real</strong> problem:
          it enters the queue and is proved by the worker (or resolved by an
          admin), then you poll for the result.
        </p>

        <div className="space-y-3">
          <Input
            placeholder="Paste an API key (or create one above)"
            value={testKey}
            onChange={(e) => setTestKey(e.target.value)}
            className="font-mono text-sm"
          />
          <Textarea
            value={problem}
            onChange={(e) => setProblem(e.target.value)}
            rows={3}
            className="text-sm"
          />
          <label className="flex cursor-pointer items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={mockMode}
              onChange={(e) => setMockMode(e.target.checked)}
              className="size-4 accent-amber-500"
            />
            <span className="text-muted-foreground">
              Mock mode {mockMode ? '(instant, free)' : '(off — real, queued)'}
            </span>
          </label>
          <Button
            onClick={runTest}
            disabled={testing || !testKey.trim()}
            className="w-full gap-2"
          >
            {testing ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <Play className="size-4" />
            )}
            {mockMode ? 'Send test request' : 'Submit to queue'}
          </Button>
          {lastJobId && (
            <Button
              onClick={pollStatus}
              disabled={polling}
              variant="outline"
              className="w-full gap-2"
            >
              {polling ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <RotateCw className="size-4" />
              )}
              Check status of {lastJobId.slice(0, 8)}
            </Button>
          )}
        </div>

        {result && (
          <pre className="mt-4 overflow-x-auto rounded-lg border bg-muted/40 p-4 font-mono text-xs">
            {result}
          </pre>
        )}

        {/* Equivalent curl */}
        <div className="mt-6">
          <div className="mb-2 flex items-center justify-between">
            <p className="font-mono text-xs uppercase tracking-wide text-muted-foreground">
              Or from your terminal
            </p>
            <CopyButton value={curl} label="Copy curl" />
          </div>
          <pre className="overflow-x-auto rounded-lg border bg-muted/40 p-4 font-mono text-xs">
            {curl}
          </pre>
        </div>
      </section>
    </div>
  );
}
