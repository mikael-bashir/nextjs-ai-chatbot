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
}

/**
 * Send a problem to the prover bridge (/prove-stream) and surface EVERY step as
 * a normalized ProverEvent: received → system/thinking/text → tool calls +
 * results/errors → verified/rejected → done. Reusable by the admin console, a
 * playground page, etc. Resolves to the final {verified, proof} outcome.
 */
export async function runProverStream(opts: RunOpts): Promise<ProverOutcome> {
  const { problem, mcpServers, model, signal, onEvent } = opts;
  const conn = bridgeConnection();
  const base = normalizeBase(opts.bridgeUrl ?? conn.bridgeUrl);
  const token = opts.token ?? conn.token ?? '';

  let seq = 0;
  const emit = (
    kind: ProverEventKind,
    label: string,
    extra: Partial<ProverEvent> = {},
  ) => onEvent({ id: ++seq, ts: Date.now(), kind, label, ...extra });

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
    res = await fetch(`${base}/prove-stream`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-bridge-token': token },
      body: JSON.stringify({ theorem: problem, mcpServers, model }),
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

      switch (d.type) {
        case 'received':
          emit('received', 'Problem received by prover', { detail: d.problem });
          break;
        case 'system':
          emit(
            'system',
            d.model ? `Model: ${d.model}` : 'Prover initialised',
            { detail: d.detail || d.text, metrics },
          );
          break;
        case 'thinking':
          emit('thinking', 'Thinking…', { detail: d.text || d.content, metrics });
          break;
        case 'text-delta':
          if (typeof d.content === 'string' && d.content.trim())
            emit('text', 'Output', { detail: d.content, metrics });
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
          outcome = { verified: !!d.verified, proof: d.proof || '' };
          emit(
            d.verified ? 'verified' : 'rejected',
            d.verified
              ? 'Proof verified by the guardrail'
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
    throw new Error('prove stream ended without a result');
  }
  emit('done', outcome.verified ? 'Done — verified' : 'Done — unverified', {
    verified: outcome.verified,
    proof: outcome.proof,
  });
  return outcome;
}
