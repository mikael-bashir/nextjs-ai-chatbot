import type { ProverMcpServer } from '@/lib/mcp/fetch-prover-servers';
import type { ProverEvent, ProverEventKind, ProverOutcome } from './types';

// ── Bridge connection (same localStorage contract AdminPipeline uses) ────────
export function bridgeConnection(): { bridgeUrl?: string; token?: string } {
  try {
    return JSON.parse(localStorage.getItem('lca.connection') || '{}');
  } catch {
    return {};
  }
}
function normalizeBase(url?: string): string {
  let b = (url || 'http://localhost:4123').replace(/\/$/, '');
  if (!/^https?:\/\//i.test(b)) b = `http://${b}`;
  return b;
}

function looksLikeToolError(output: string): boolean {
  return /compilation failed|❌|error:|exception|traceback|invalid|failed/i.test(
    output,
  );
}

interface RunOpts {
  problem: string;
  mcpServers: ProverMcpServer[];
  model?: string;
  bridgeUrl?: string;
  token?: string;
  signal?: AbortSignal;
  onEvent: (e: ProverEvent) => void;
  // When set, the FULL agent context (system prompt, model, MCP inventory) and
  // the outcome are persisted to the admin debug log. The endpoint is admin-
  // gated server-side, so this is a no-op (silently ignored) for non-admins.
  source?: string;
  // Which bridge route to drive. 'prove-stream' (default) is the single-agent
  // prover; 'prove-tree' is the decomposition orchestrator (prove-or-split proof
  // tree). Both emit the identical SSE shape, so this runner handles either.
  endpoint?: 'prove-stream' | 'prove-tree';
  // Strategy mode for the tree path (A/B testing proof approaches): e.g.
  // 'hacker' (compiler-driven) or 'pantograph' (interactive Leak II). Ignored by
  // the single-agent path.
  strategy?: string;
}

// Fire-and-forget: persist a run to the admin debug log. Admin-gated server-side.
async function logAgentRun(record: Record<string, unknown>) {
  try {
    await fetch('/api/admin/agent-log', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(record),
      keepalive: true,
    });
  } catch {
    /* logging must never affect the prove */
  }
}

/**
 * Send a problem to the prover bridge (/prove-stream) and surface EVERY step as
 * a normalized ProverEvent: received → system/thinking/text → tool calls +
 * results/errors → verified/rejected → done. Reusable by the admin console, a
 * playground page, etc. Resolves to the final {verified, proof} outcome.
 */
export async function runProverStream(opts: RunOpts): Promise<ProverOutcome> {
  const { problem, mcpServers, model, signal, onEvent, source } = opts;
  const endpoint = opts.endpoint ?? 'prove-stream';
  const conn = bridgeConnection();
  const base = normalizeBase(opts.bridgeUrl ?? conn.bridgeUrl);
  const token = opts.token ?? conn.token ?? '';

  let seq = 0;
  // Accumulate the full activity flow for the admin debug log so a finished run
  // can be reviewed after the fact — the same events the console renders. Long
  // fields are truncated and the array is capped so a persisted row stays sane.
  const MAX_LOG_EVENTS = 1500;
  const FIELD_CAP = 4000;
  const cap = (s?: string) =>
    typeof s === 'string' && s.length > FIELD_CAP
      ? `${s.slice(0, FIELD_CAP)}\n…[truncated ${s.length - FIELD_CAP} chars]`
      : s;
  const activityLog: ProverEvent[] = [];
  const emit = (
    kind: ProverEventKind,
    label: string,
    extra: Partial<ProverEvent> = {},
  ) => {
    const ev: ProverEvent = { id: ++seq, ts: Date.now(), kind, label, ...extra };
    onEvent(ev);
    if (activityLog.length < MAX_LOG_EVENTS) {
      // Store without the per-event `metrics` (kept once, separately) and with
      // long text fields truncated.
      activityLog.push({
        id: ev.id,
        ts: ev.ts,
        kind: ev.kind,
        label: ev.label,
        tool: ev.tool,
        input: cap(ev.input),
        detail: cap(ev.detail),
        proof: cap(ev.proof),
        disproof: cap(ev.disproof),
        verified: ev.verified,
        refuted: ev.refuted,
        counterexample: ev.counterexample,
      });
    }
  };

  // Immediate client-side feedback before the stream opens.
  emit('received', `Problem received by prover`, { detail: problem });
  if (mcpServers.length) {
    emit(
      'system',
      `Prover armed with ${mcpServers.length} MCP server(s): ${mcpServers.map((s) => s.name).join(', ')}`,
    );
  }

  let res: Response;
  try {
    res = await fetch(`${base}/${endpoint}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-bridge-token': token },
      // NOTE: the bridge reads model + strategy from `options` (body.options),
      // so they MUST go there — a top-level `model` is ignored by the prove
      // paths. (Kept top-level too for the debug log / backwards-compat.)
      body: JSON.stringify({
        theorem: problem,
        mcpServers,
        model,
        options: {
          ...(opts.strategy ? { strategy: opts.strategy } : {}),
          ...(model ? { model } : {}),
        },
      }),
      signal,
    });
  } catch (e) {
    emit('error', `Could not reach the bridge at ${base}`, {
      detail: String(e),
    });
    throw new Error('bridge unreachable');
  }
  if (!res.ok || !res.body) {
    emit('error', `Bridge returned ${res.status}`);
    throw new Error(`bridge ${res.status}`);
  }

  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  let outcome: ProverOutcome | null = null;
  // Captured for the admin debug log: the exact context the bridge handed the
  // agent (from the `prompt` event) plus the closing text + latest metrics.
  let context: {
    prompt?: string;
    model?: string | null;
    mcpServers?: unknown;
  } | null = null;
  let finalText = '';
  let lastMetrics: unknown;
  const flush = () => {
    if (!source) return;
    logAgentRun({
      source,
      theorem: problem,
      model: context?.model ?? model ?? null,
      prompt: context?.prompt ?? null,
      mcpServers: context?.mcpServers ?? mcpServers,
      verified: outcome?.verified ?? false,
      proof: outcome?.proof ?? '',
      finalText,
      metrics: lastMetrics,
      events: activityLog,
    });
  };

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const events = buf.split('\n\n');
    buf = events.pop() || '';
    for (const e of events) {
      if (!e.startsWith('data:')) continue;
      let d: any;
      try {
        d = JSON.parse(e.replace(/^data:\s*/, ''));
      } catch {
        continue;
      }
      const metrics = d.metrics;
      if (metrics) lastMetrics = metrics;

      switch (d.type) {
        case 'received':
          emit('received', 'Problem received by prover', { detail: d.problem });
          break;
        case 'prompt':
          // The exact context the bridge built for the agent (admin debug log).
          context = {
            prompt: d.prompt,
            model: d.model,
            mcpServers: d.mcpServers,
          };
          emit('system', 'Full agent context captured', { detail: d.prompt });
          break;
        case 'system': {
          // Claude Code emits the rich init frame (model + connected MCP servers
          // + tool count) once, but also bare `system` frames (status / MCP
          // (re)connect). Only surface ones that carry real info — never render a
          // bare frame as a repeated "Prover initialised".
          const sysDetail = d.detail || d.text || '';
          if (d.model)
            emit('system', `Model: ${d.model}`, { detail: sysDetail, metrics });
          else if (sysDetail.trim())
            emit('system', sysDetail.slice(0, 140), {
              detail: sysDetail,
              metrics,
            });
          break;
        }
        case 'thinking':
          emit('thinking', 'Thinking…', { detail: d.text || d.content, metrics });
          break;
        case 'text-delta':
          if (typeof d.content === 'string' && d.content.trim()) {
            finalText += d.content;
            emit('text', 'Output', { detail: d.content, metrics });
          }
          break;
        case 'message-annotation': {
          if (d.subtype === 'tool_intent') {
            emit('tool_call', `Tool → ${d.tool}`, {
              tool: d.tool,
              input: d.input,
              metrics,
            });
          } else if (d.subtype === 'tool_result') {
            const out = String(d.output ?? '');
            if (looksLikeToolError(out))
              emit('tool_error', `Tool error`, { detail: out, metrics });
            else emit('tool_result', `Tool result`, { detail: out, metrics });
          } else if (d.subtype === 'error') {
            emit('rejected', d.thought || 'Rejected', { metrics });
          } else if (d.subtype === 'formalising') {
            emit('formalising', d.thought || 'Formalising the statement…', {
              detail: d.detail,
              metrics,
            });
          } else {
            // status / anything else with a thought
            if (d.thought)
              emit('text', d.thought.slice(0, 200), {
                detail: d.thought,
                metrics,
              });
          }
          break;
        }
        case 'done':
          outcome = {
            verified: !!d.verified,
            proof: d.proof || '',
            refuted: !!d.refuted,
            counterexample: d.counterexample,
            disproof: d.disproof,
          };
          emit(
            d.verified ? 'verified' : 'rejected',
            d.verified
              ? 'Proof verified by the guardrail'
              : d.refuted
                ? `Refuted — theorem is false (${d.counterexample || 'counterexample verified'})`
                : 'No verified proof produced',
            { verified: !!d.verified, proof: d.proof || '', metrics },
          );
          break;
        case 'error':
          emit('error', d.message || 'Prover error', { metrics });
          break;
        default:
          break;
      }
    }
  }

  if (!outcome) {
    emit('error', 'Prover stream ended without a result');
    flush();
    throw new Error('prove stream ended without a result');
  }
  emit('done', outcome.verified ? 'Done — verified' : 'Done — unverified', {
    verified: outcome.verified,
    proof: outcome.proof,
  });
  flush();
  return outcome;
}
