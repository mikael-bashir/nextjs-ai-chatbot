'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  RefreshCw,
  ShieldCheck,
  ShieldAlert,
  Copy,
  Check,
} from 'lucide-react';
import type { ProverEvent } from '@/lib/prover/types';

interface LogRow {
  id: string;
  source: string;
  theorem: string;
  model: string | null;
  prompt: string | null;
  mcpServers: unknown;
  verified: boolean | null;
  proof: string | null;
  finalText: string | null;
  metrics: unknown;
  // The full activity flow captured during the run (may be absent on old rows).
  events: ProverEvent[] | null;
  createdAt: string;
}

function timeStr(ts: number): string {
  return new Date(ts).toLocaleTimeString([], {
    hour12: false,
    minute: '2-digit',
    second: '2-digit',
  });
}

// Serialize a stored run's activity flow to the SAME plain-text shape the live
// console's "Copy log" produces, so it can be pasted straight into a debug chat.
function serializeEvents(r: LogRow): string {
  const events = Array.isArray(r.events) ? r.events : [];
  const indent = (s: string) =>
    s
      .split('\n')
      .map((l) => `    ${l}`)
      .join('\n');
  const out: string[] = [
    `=== ${r.source} · ${r.model || '—'} · ${new Date(r.createdAt).toLocaleString()} ===`,
    r.theorem,
    `outcome: ${r.verified ? 'verified' : 'not verified'} · ${events.length} events`,
  ];
  for (const e of events) {
    out.push('');
    out.push(`[${timeStr(e.ts)}] ${String(e.kind).toUpperCase()} — ${e.label}`);
    if (e.input?.trim()) out.push(indent(e.input));
    if (e.detail?.trim()) out.push(indent(e.detail));
    if (e.proof?.trim()) out.push(indent(`PROOF:\n${e.proof}`));
    if (e.disproof?.trim()) out.push(indent(`DISPROOF:\n${e.disproof}`));
  }
  if (r.finalText?.trim()) out.push(`\n=== final text ===\n${r.finalText}`);
  return out.join('\n');
}

function CopyLogButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        } catch {
          /* clipboard unavailable */
        }
      }}
      title="Copy the full activity flow of this run"
      className="inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground hover:bg-muted hover:text-foreground"
    >
      {copied ? <Check className="size-3" /> : <Copy className="size-3" />}
      {copied ? 'Copied' : 'Copy log'}
    </button>
  );
}

function Field({ label, value }: { label: string; value?: string | null }) {
  if (!value) return null;
  return (
    <details className="mt-2">
      <summary className="cursor-pointer text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </summary>
      <pre className="mt-1 max-h-72 overflow-auto whitespace-pre-wrap break-words rounded bg-muted/60 p-2 font-mono text-[11px] leading-relaxed">
        {value}
      </pre>
    </details>
  );
}

// Admin-only: shows the FULL context every prover run handed the agent (system
// prompt, MCP inventory, theorem, model) + outcome — so we can debug why it
// flails. Auto-populated whenever an admin runs the prover.
export function AdminAgentLogs() {
  const [rows, setRows] = useState<LogRow[]>([]);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/admin/agent-log');
      if (res.ok) setRows((await res.json()).items ?? []);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <div className="rounded-lg border bg-card">
      <div className="flex items-center gap-2 border-b bg-muted/40 px-3 py-2">
        <span className="text-xs font-semibold">Agent debug log</span>
        <span className="text-[11px] text-muted-foreground">
          full prompt + context per run (admin only)
        </span>
        <button
          type="button"
          onClick={load}
          className="ml-auto inline-flex items-center gap-1 rounded border px-2 py-0.5 text-[11px] hover:bg-muted"
        >
          <RefreshCw className={`size-3 ${loading ? 'animate-spin' : ''}`} />
          Refresh
        </button>
      </div>
      <div className="max-h-[32rem] divide-y divide-border/50 overflow-y-auto">
        {rows.length === 0 ? (
          <p className="px-3 py-6 text-center text-xs text-muted-foreground">
            No runs logged yet. Run a prove from the playground, ACG, or queue.
          </p>
        ) : (
          rows.map((r) => {
            const mcp =
              r.mcpServers != null
                ? JSON.stringify(r.mcpServers, null, 2)
                : null;
            const metrics =
              r.metrics != null ? JSON.stringify(r.metrics, null, 2) : null;
            const eventCount = Array.isArray(r.events) ? r.events.length : 0;
            const activity = eventCount ? serializeEvents(r) : null;
            return (
              <div key={r.id} className="px-3 py-2">
                <div className="flex items-center gap-2 text-xs">
                  {r.verified ? (
                    <ShieldCheck className="size-3.5 text-emerald-500" />
                  ) : (
                    <ShieldAlert className="size-3.5 text-amber-500" />
                  )}
                  <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium uppercase">
                    {r.source}
                  </span>
                  <span className="font-mono text-[10px] text-muted-foreground">
                    {r.model || '—'}
                  </span>
                  {activity && <CopyLogButton text={activity} />}
                  <span className="ml-auto font-mono text-[10px] text-muted-foreground/70">
                    {new Date(r.createdAt).toLocaleString()}
                  </span>
                </div>
                <p className="mt-1 truncate font-mono text-[11px]" title={r.theorem}>
                  {r.theorem}
                </p>
                <Field
                  label={`Activity flow (${eventCount} steps)`}
                  value={activity}
                />
                <Field label="System prompt (exact)" value={r.prompt} />
                <Field label="MCP servers + tools" value={mcp} />
                <Field label="Final text" value={r.finalText} />
                <Field label="Proof" value={r.proof} />
                <Field label="Metrics" value={metrics} />
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
