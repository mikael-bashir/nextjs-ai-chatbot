// Hosted Claude Agent SDK prover — the AUTONOMOUS half of the deployment queue.
//
// It drains the same ProblemJob queue the operator's bridge drains, but as the
// `hosted` worker kind: it takes ordinary jobs and SKIPS any an admin delegated
// to their own bridge (see leaseNextJob's kind filter). The operator's bridge
// (WORKER_KIND=operator) takes the delegated ones. So the two coexist:
//   • hosted agent  — always on, proves via the Anthropic API (metered, real $)
//   • operator bridge — pulled in at peak / for chosen problems, cheaper compute
//
// Wire-compatible with the bridge's worker protocol on purpose (same lease /
// heartbeat / complete calls), so the app's billing (charge 1.2× costUsd on
// success OR failure) works identically no matter which worker ran the job.
import { query } from '@anthropic-ai/claude-agent-sdk';

// --- config ---------------------------------------------------------------
const WORKER_URL = (process.env.WORKER_URL || '').replace(/\/$/, '');
// The shared queue secret. Accept either name so the compose service can just
// inherit the app's LEAK_WORKER_SECRET from .env without remapping.
const WORKER_SECRET =
  process.env.WORKER_SECRET || process.env.LEAK_WORKER_SECRET || '';
const WORKER_ID = process.env.WORKER_ID || `hosted-agent-${process.pid}`;
// This process is, by definition, the hosted worker.
const WORKER_KIND = 'hosted';
const WORKER_MODEL = process.env.WORKER_MODEL || 'claude-opus-4-8';
const WORKER_POLL_MS = Math.max(Number(process.env.WORKER_POLL_MS) || 5000, 1000);
const HEARTBEAT_MS = 30_000;

// Prover MCP servers (Leak_I search, Leak_II Lean daemon, Leak_IV verify).
// The lease response provides them (from the app's getProverMcpServers); this
// env is the fallback / override. A JSON array of { name, url, type? }.
let ENV_MCP = [];
try {
  const raw = process.env.LEAK_PROVER_MCP_CONFIG || process.env.WORKER_MCP_CONFIG;
  if (raw) ENV_MCP = JSON.parse(raw);
  if (!Array.isArray(ENV_MCP)) ENV_MCP = [];
} catch {
  console.error('[hosted] LEAK_PROVER_MCP_CONFIG is not valid JSON — ignoring');
  ENV_MCP = [];
}

// --- worker protocol (identical shape to the bridge) ----------------------
function workerHeaders() {
  return { 'content-type': 'application/json', 'x-worker-secret': WORKER_SECRET };
}

async function leaseJob() {
  const res = await fetch(`${WORKER_URL}/api/worker/lease`, {
    method: 'POST',
    headers: workerHeaders(),
    body: JSON.stringify({ workerId: WORKER_ID, kind: WORKER_KIND }),
  });
  if (!res.ok) throw new Error(`lease responded ${res.status}`);
  const data = await res.json();
  return data.job || null;
}

async function workerComplete(jobId, body) {
  await fetch(`${WORKER_URL}/api/worker/complete`, {
    method: 'POST',
    headers: workerHeaders(),
    body: JSON.stringify({ jobId, workerId: WORKER_ID, ...body }),
  }).catch((e) => console.error('[hosted] complete POST failed:', e.message));
}

async function workerHeartbeat(jobId) {
  await fetch(`${WORKER_URL}/api/worker/heartbeat`, {
    method: 'POST',
    headers: workerHeaders(),
    body: JSON.stringify({ jobId, workerId: WORKER_ID, status: 'proving' }),
  }).catch(() => {});
}

// --- Agent SDK prover -----------------------------------------------------
// The lease hands us [{ name, url }]; the SDK wants { name: { type, url } }.
// Leak servers speak streamable-HTTP by default; a server entry may carry an
// explicit `type: 'sse'` (via LEAK_PROVER_MCP_CONFIG) to override.
function toSdkMcpServers(list) {
  const out = {};
  for (const s of Array.isArray(list) ? list : []) {
    if (!s?.name || !s?.url) continue;
    out[String(s.name)] = {
      type: s.type === 'sse' ? 'sse' : 'http',
      url: String(s.url),
    };
  }
  return out;
}

// The daemon-gated success string — SAME test the bridge uses, so a hosted
// proof and a bridge proof mean exactly the same thing.
const VERIFY_OK = /compilation successful|100% verified/i;
const VERIFY_FAIL = /compilation failed|❌/;
function isVerifiedResult(text) {
  return VERIFY_OK.test(text) && !VERIFY_FAIL.test(text);
}

function textOf(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((c) =>
        typeof c === 'string'
          ? c
          : typeof c?.text === 'string'
            ? c.text
            : typeof c?.content === 'string'
              ? c.content
              : '',
      )
      .join('\n');
  }
  if (content && typeof content.text === 'string') return content.text;
  return '';
}

// Defensive: the SDK surfaces tool calls/results in a few shapes across
// versions (top-level tool_use/tool_result messages, or content blocks on
// assistant/user messages). Pull both out of whatever shape a message has.
function extractBlocks(m) {
  const toolUses = [];
  const toolResults = [];
  const pushUse = (b) => {
    if (b?.id) toolUses.push({ id: b.id, name: b.name, input: b.input });
  };
  const pushResult = (b) => {
    const id = b?.tool_use_id ?? b?.toolUseId;
    if (id) toolResults.push({ tool_use_id: id, text: textOf(b.content) });
  };
  if (m?.type === 'tool_use') pushUse(m);
  if (m?.type === 'tool_result') pushResult(m);
  const content = m?.message?.content ?? m?.content;
  if (Array.isArray(content)) {
    for (const b of content) {
      if (b?.type === 'tool_use') pushUse(b);
      else if (b?.type === 'tool_result') pushResult(b);
    }
  }
  return { toolUses, toolResults };
}

function proverSystemPrompt() {
  return `You are a Lean 4 + Mathlib power user proving a theorem. You already KNOW Lean 4 and a great deal of Mathlib. Prove by HACKING: write real Lean and let the compiler's errors drive you. Do NOT research the library first — that wastes turns.

You have MCP tools from the Leak prover servers, callable DIRECTLY by their mcp__…__… names (they appear in your tool list — no loading step). The important ones:
- a verify_full_script tool — your MAIN loop and SOURCE OF TRUTH: compile a whole Lean script, read the errors, fix, recompile. Live here.
- Lean-daemon step tools (init_proof, apply_tactic, get_current_proof_state) — step ONE tactic at a time to SEE the exact goal state when an error is opaque. Use to understand, not to browse.
- search tools (loogle_search, moogle_search) — LAST resort, only when the compiler reports a specific NAME you cannot recall.

MINDSET: the compiler is your teacher. Strong automation closes most goals — reach for it first: decide / native_decide (bounded / ZMod / Finset), omega / linarith / nlinarith [sq_nonneg _, …] / positivity / ring / field_simp, simp / simp only / norm_num / push_cast, fin_cases / interval_cases / rcases / induction. Try the one-liner your instinct suggests FIRST.

WORKFLOW:
1. IMMEDIATELY write a full candidate proof from your own knowledge (replace sorry) and call verify_full_script. Your first tool call is verify_full_script, not a search.
2. Read the errors, fix the script, recompile. Repeat. Step opaque goals with init_proof/apply_tactic, then fold what worked back in.
3. Only if the compiler reports an UNKNOWN IDENTIFIER you cannot recall, do ONE quick search for that exact name, then get straight back to compiling.
4. Done ONLY when verify_full_script reports success ("Compilation Successful" / "100% verified") on a script containing the ORIGINAL theorem (same name + signature) with NO sorry. Output that final verified proof as one \`\`\`lean code block.

Spend your turns COMPILING, not searching. The verified script is the deliverable.`;
}

function proverTask(theorem) {
  return `Prove the following Lean 4 theorem. Drive verify_full_script until it reports the proof is verified, then output the final verified proof in a single \`\`\`lean block.

Theorem:
${theorem}`;
}

// Run the agent on one theorem. Returns { verified, proof, costUsd, ... }.
async function proveWithSDK(theorem, mcpList, maxCostUsd) {
  const mcpServers = toSdkMcpServers(mcpList);
  const abortController = new AbortController();
  const toolUses = new Map(); // tool_use_id -> { name, script }
  let verified = false;
  let proof = '';
  let costUsd = 0;
  let tokensInput = 0;
  let tokensOutput = 0;

  const options = {
    model: WORKER_MODEL,
    systemPrompt: proverSystemPrompt(),
    mcpServers,
    // Server-side worker in a locked container — auto-approve tool use so the
    // agent runs unattended. No file/network tools are needed beyond MCP.
    permissionMode: 'bypassPermissions',
    abortController,
  };
  // The real ceiling is the customer's balance (metered billing), handed to us
  // on lease as maxCostUsd = balance / (markup × fx). That's not an artificial
  // cap — it's what they can pay. Only when the lease can't supply one (edge
  // cases: no balance/fx) fall back to a generous runaway guard: an API-billed
  // worker must never spin unbounded (e.g. retrying against an unreachable MCP).
  // WORKER_MAX_COST_USD defaults high enough not to clip a genuine monster proof.
  options.maxBudgetUsd =
    Number.isFinite(maxCostUsd) && maxCostUsd > 0
      ? maxCostUsd
      : Number(process.env.WORKER_MAX_COST_USD) || 50;

  for await (const m of query({ prompt: proverTask(theorem), options })) {
    const { toolUses: tu, toolResults: tr } = extractBlocks(m);
    for (const u of tu) {
      toolUses.set(u.id, { name: u.name || '', script: u?.input?.script });
    }
    for (const r of tr) {
      const u = toolUses.get(r.tool_use_id);
      if (
        u &&
        /verify_full_script/i.test(u.name) &&
        isVerifiedResult(r.text) &&
        u.script &&
        String(u.script).trim()
      ) {
        // Latest daemon-verified script wins — that's exactly what compiled.
        verified = true;
        proof = String(u.script);
      }
    }
    if (m?.type === 'result') {
      if (typeof m.total_cost_usd === 'number') costUsd = m.total_cost_usd;
      if (typeof m.input_tokens === 'number') tokensInput = m.input_tokens;
      if (typeof m.output_tokens === 'number') tokensOutput = m.output_tokens;
    }
  }

  const budgetExceeded = abortController.signal.aborted;
  return { verified, proof, costUsd, tokensInput, tokensOutput, budgetExceeded };
}

async function proveLeasedJob(job) {
  const mcp =
    Array.isArray(job.mcpServers) && job.mcpServers.length ? job.mcpServers : ENV_MCP;
  if (!mcp.length) {
    console.warn(
      `[hosted] job ${job.id} has NO prover MCP servers — set LEAK_PROVER_MCP_CONFIG or register them; will fail`,
    );
  }
  const beat = setInterval(() => workerHeartbeat(job.id), HEARTBEAT_MS);
  const modelId = WORKER_MODEL;
  try {
    const out = await proveWithSDK(
      job.problem,
      mcp,
      typeof job.maxCostUsd === 'number' ? job.maxCostUsd : Number.POSITIVE_INFINITY,
    );
    clearInterval(beat);
    const costUsd = typeof out.costUsd === 'number' ? out.costUsd : 0;
    // Pay-for-compute: report costUsd either way so the app bills 1.2× actual on
    // success OR failure. Complete (with a proof) ONLY on a daemon-verified script.
    if (out.verified && out.proof.trim()) {
      await workerComplete(job.id, {
        proof: out.proof,
        costUsd,
        tokensInput: out.tokensInput,
        tokensOutput: out.tokensOutput,
        modelId,
      });
      console.log(`[hosted] proved ${job.id} ($${costUsd.toFixed(4)})`);
    } else {
      const error = out.budgetExceeded
        ? 'aborted: run cost would exceed remaining balance'
        : 'no verified proof produced';
      await workerComplete(job.id, {
        error,
        costUsd,
        tokensInput: out.tokensInput,
        tokensOutput: out.tokensOutput,
        modelId,
      });
      console.log(`[hosted] failed ${job.id} ($${costUsd.toFixed(4)}): ${error}`);
    }
  } catch (e) {
    clearInterval(beat);
    await workerComplete(job.id, { error: e.message, costUsd: 0, modelId });
    console.error(`[hosted] error on ${job.id}:`, e.message);
  }
}

async function workerLoop() {
  console.log(
    `[hosted] draining queue at ${WORKER_URL} as ${WORKER_ID} (kind=${WORKER_KIND}, model=${WORKER_MODEL})`,
  );
  for (;;) {
    let got = false;
    try {
      const job = await leaseJob();
      if (job) {
        console.log(`[hosted] leased ${job.id}`);
        await proveLeasedJob(job);
        got = true; // handled a job — loop again immediately
      }
    } catch (e) {
      console.error('[hosted] lease error:', e.message);
    }
    if (!got) await new Promise((r) => setTimeout(r, WORKER_POLL_MS));
  }
}

if (!WORKER_URL || !WORKER_SECRET) {
  console.error(
    '[hosted] WORKER_URL and WORKER_SECRET (or LEAK_WORKER_SECRET) are required — exiting',
  );
  process.exit(1);
}
if (!process.env.ANTHROPIC_API_KEY) {
  console.error('[hosted] ANTHROPIC_API_KEY is required — exiting');
  process.exit(1);
}
workerLoop();
