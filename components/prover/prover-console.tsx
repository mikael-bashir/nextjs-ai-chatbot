'use client';

import { useEffect, useRef, useState } from 'react';
import {
  Inbox,
  Cpu,
  Sigma,
  Brain,
  MessageSquare,
  Wrench,
  CornerDownLeft,
  TriangleAlert,
  ShieldCheck,
  ShieldAlert,
  XCircle,
  Flag,
  Loader2,
  Copy,
  Check,
} from 'lucide-react';

import type { ProverEvent, ProverEventKind } from '@/lib/prover/types';

// Presentational only — feed it events from runProverStream. Drop it into the
// admin console, a playground page, anywhere.
const STYLE: Record<
  ProverEventKind,
  { icon: React.ElementType; color: string }
> = {
  received: { icon: Inbox, color: 'text-sky-500' },
  system: { icon: Cpu, color: 'text-muted-foreground' },
  formalising: { icon: Sigma, color: 'text-violet-500' },
  thinking: { icon: Brain, color: 'text-muted-foreground' },
  text: { icon: MessageSquare, color: 'text-foreground/70' },
  tool_call: { icon: Wrench, color: 'text-blue-500' },
  tool_result: { icon: CornerDownLeft, color: 'text-emerald-500' },
  tool_error: { icon: TriangleAlert, color: 'text-rose-500' },
  verified: { icon: ShieldCheck, color: 'text-emerald-500' },
  rejected: { icon: ShieldAlert, color: 'text-amber-500' },
  error: { icon: XCircle, color: 'text-destructive' },
  done: { icon: Flag, color: 'text-muted-foreground' },
};

function timeStr(ts: number): string {
  const d = new Date(ts);
  return d.toLocaleTimeString([], {
    hour12: false,
    minute: '2-digit',
    second: '2-digit',
  });
}

// Serialize the WHOLE run — every entry fully expanded (no truncation, no
// collapsing) — into a plain-text block for pasting into a debug session.
function fullLogText(events: ProverEvent[], title: string): string {
  const indent = (s: string) =>
    s
      .split('\n')
      .map((l) => `    ${l}`)
      .join('\n');
  const out: string[] = [`=== ${title} — ${events.length} entries ===`];
  const last = [...events].reverse().find((e) => e.metrics)?.metrics;
  if (last) {
    const bits = [
      typeof last.llm_invocations === 'number' && `${last.llm_invocations} llm`,
      typeof last.tools_invoked === 'number' && `${last.tools_invoked} tools`,
      typeof last.time_elapsed === 'number' && `${last.time_elapsed}s`,
    ].filter(Boolean);
    if (bits.length) out.push(bits.join(' · '));
  }
  for (const e of events) {
    out.push('');
    out.push(`[${timeStr(e.ts)}] ${e.kind.toUpperCase()} — ${e.label}`);
    if (e.input?.trim()) out.push(indent(e.input));
    if (e.detail?.trim()) out.push(indent(e.detail));
    if (e.proof?.trim()) out.push(indent(`PROOF:\n${e.proof}`));
    if (e.disproof?.trim()) out.push(indent(`DISPROOF:\n${e.disproof}`));
  }
  return out.join('\n');
}

function CopyLogButton({
  events,
  title,
}: {
  events: ProverEvent[];
  title: string;
}) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(fullLogText(events, title));
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        } catch {
          /* clipboard unavailable (insecure context) — nothing to do */
        }
      }}
      title="Copy the full run log (every entry expanded) to the clipboard"
      className="flex items-center gap-1 rounded border px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
    >
      {copied ? <Check className="size-3" /> : <Copy className="size-3" />}
      {copied ? 'Copied' : 'Copy log'}
    </button>
  );
}

function Row({ e }: { e: ProverEvent }) {
  const { icon: Icon, color } = STYLE[e.kind] ?? STYLE.text;
  const body = e.input ?? e.detail;
  return (
    <div className="flex gap-2 px-3 py-1.5 hover:bg-muted/40">
      <Icon className={`mt-0.5 size-3.5 shrink-0 ${color}`} />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <span className="truncate text-xs">
            {e.tool ? (
              <>
                <span className="text-muted-foreground">{e.label.replace(e.tool, '')}</span>
                <span className="font-mono font-medium">{e.tool}</span>
              </>
            ) : (
              e.label
            )}
          </span>
          <span className="ml-auto shrink-0 font-mono text-[10px] text-muted-foreground/60">
            {timeStr(e.ts)}
          </span>
        </div>
        {body && body.trim() && (
          <details className="group mt-0.5">
            <summary className="cursor-pointer list-none font-mono text-[11px] text-muted-foreground/70 hover:text-muted-foreground">
              <span className="line-clamp-1 group-open:hidden">
                {body.replace(/\s+/g, ' ').trim().slice(0, 160)}
              </span>
              <span className="hidden group-open:inline">▾ collapse</span>
            </summary>
            <pre className="mt-1 max-h-56 overflow-auto whitespace-pre-wrap break-words rounded bg-muted/60 p-2 font-mono text-[11px] leading-relaxed">
              {body}
            </pre>
          </details>
        )}
      </div>
    </div>
  );
}

export function ProverConsole({
  events,
  running = false,
  title = 'Prover activity',
  emptyHint = 'No activity yet — send a problem to the prover.',
  className = '',
}: {
  events: ProverEvent[];
  running?: boolean;
  title?: string;
  emptyHint?: string;
  className?: string;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  // Auto-scroll to the newest line unless the user has scrolled up.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const nearBottom =
      el.scrollHeight - el.scrollTop - el.clientHeight < 120;
    if (nearBottom) el.scrollTop = el.scrollHeight;
  }, [events]);

  const lastMetrics = [...events].reverse().find((e) => e.metrics)?.metrics;

  return (
    <div className={`overflow-hidden rounded-lg border bg-card ${className}`}>
      <div className="flex items-center gap-2 border-b bg-muted/40 px-3 py-2">
        {running ? (
          <Loader2 className="size-3.5 animate-spin text-blue-500" />
        ) : (
          <Cpu className="size-3.5 text-muted-foreground" />
        )}
        <span className="text-xs font-semibold">{title}</span>
        <div className="ml-auto flex items-center gap-3">
          {lastMetrics && (
            <span className="flex items-center gap-3 font-mono text-[10px] text-muted-foreground">
              {typeof lastMetrics.llm_invocations === 'number' && (
                <span>{lastMetrics.llm_invocations} llm</span>
              )}
              {typeof lastMetrics.tools_invoked === 'number' && (
                <span>{lastMetrics.tools_invoked} tools</span>
              )}
              {typeof lastMetrics.time_elapsed === 'number' && (
                <span>{lastMetrics.time_elapsed}s</span>
              )}
            </span>
          )}
          {events.length > 0 && <CopyLogButton events={events} title={title} />}
        </div>
      </div>
      <div ref={scrollRef} className="max-h-96 overflow-y-auto divide-y divide-border/40">
        {events.length === 0 ? (
          <p className="px-3 py-6 text-center text-xs text-muted-foreground">
            {emptyHint}
          </p>
        ) : (
          events.map((e) => <Row key={e.id} e={e} />)
        )}
      </div>
    </div>
  );
}
