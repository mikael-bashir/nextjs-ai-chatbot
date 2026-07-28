// Statement elaboration pre-check — does the generated Lean theorem TYPECHECK?
//
// WHY THIS EXISTS. A generated problem can be perfectly good mathematics and
// still carry a Lean signature that never elaborates, most often because a
// value the model bound as a plain variable is later used as a TYPE:
//
//     (N : ℕ) (hN : N = 2^100 + 2^50 + 1) ... (lamp : ℕ → ZMod N → Bool)
//         ⇒ failed to synthesize instance of type class Fintype (ZMod N)
//
// `hN` is propositional, so instance search cannot see through it to learn
// N ≠ 0. Nothing downstream can recover from this: the prover's target
// signature is immutable, so blueprint refinement cannot repair the theorem's
// own opening line, and every refinement iteration is spent re-discovering an
// edit it is not allowed to make. One such problem burned a full 366-entry,
// 600-second prover run before forfeiting. Catching it here — before the hard
// verifier, the gauntlet, the assessor and the whole verification queue — costs
// one Lean compile.
//
// This is a check of WELL-FORMEDNESS, not of TRUTH. A statement that passes may
// still be false; that is exactly what the prover exists to determine.
//
// HOW IT RUNS — bridge only, no other service.
//   browser → local bridge (/verify-statement) → Lean daemon over MCP-SSE
// The bridge is already running (it drives generation), and it already owns a
// hardened MCP-SSE client with daemon-hiccup retries, so it acts as the MCP
// connection manager here. Nothing else has to be kept up: no Python process,
// and no local Lean toolchain. The only other call is to /api/mcp/servers,
// which is the app's own Postgres-backed list — it is NOT the Python manager.

export const ELABORATION_TOOL_NAME = 'verify_full_script';

// Thrown when the check cannot run at all — bridge unreachable, no MCP server
// registered, daemon down. Kept distinct from a compile failure: this is an
// infrastructure problem the user must fix, NOT a verdict on the problem, so
// the caller must surface it in the UI rather than discarding the generated
// problem as if it were malformed.
export class ElaborationUnavailableError extends Error {
  readonly kind = 'unavailable';
  constructor(message: string) {
    super(message);
    this.name = 'ElaborationUnavailableError';
  }
}

export interface ElaborationVerdict {
  /** True when the compiler reported no errors — a lone `sorry` warning is fine. */
  elaborates: boolean;
  errors: string[];
  warnings: string[];
  /** The daemon's verbatim reply, for the activity console's detail pane. */
  raw: string;
  /** Which daemon answered, for the console line. */
  serverUrl?: string;
}

/** Minimal shape of a registered MCP server (from the app's own DB route). */
export interface ElaborationServer {
  name: string;
  url: string;
  tools?: { name: string }[];
}

type FetchFn = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

/** Posts to the local bridge. Supplied by the caller (see callBridge). */
export type BridgePost = (
  path: string,
  init?: RequestInit,
) => Promise<Response>;

/**
 * Wrap a bare theorem in a compilable file. The generated `lean` field is a
 * single self-contained declaration (enforced by leanSplitsIntoSeparateDecl)
 * and assumes an ambient Mathlib, so the only thing missing is the import.
 *
 * The body is deliberately left as `sorry`: we are asking "does this SIGNATURE
 * elaborate?", not "is it provable?". `sorry` elaborates against any well-typed
 * goal, so any diagnostic that survives is a genuine statement defect.
 */
export function buildElaborationScript(lean: string): string {
  const body = String(lean || '').trim();
  const withProof = /:=/.test(body) ? body : `${body} := by sorry`;
  return `import Mathlib\n\n${withProof}\n`;
}

/**
 * Read the daemon's reply. It reports overall failure whenever ANY diagnostic
 * is present, and a `sorry` counts as a warning — so "compilation failed"
 * cannot be the signal. What matters is whether any line is an (Error):
 *
 *   Line 8 (Error): failed to synthesize instance ...   → broken statement
 *   Line 3 (Warning): declaration uses `sorry`          → well-formed
 */
export function parseElaborationVerdict(text: string): ElaborationVerdict {
  const raw = String(text || '');
  const errors: string[] = [];
  const warnings: string[] = [];
  for (const line of raw.split('\n')) {
    const m = line.match(/^\s*Line\s+\d+\s+\((Error|Warning)\)\s*:\s*(.*)$/i);
    if (!m) continue;
    const entry = line.trim();
    if (m[1].toLowerCase() === 'error') errors.push(entry);
    else warnings.push(entry);
  }
  const explicitOk = /compilation successful/i.test(raw);
  // Guard against a reply we could not parse at all: if the daemon said it
  // failed and we found no diagnostic lines, treat that as an error rather than
  // silently passing a statement we never actually checked.
  const unparsedFailure =
    !explicitOk && !errors.length && !warnings.length && /failed|error/i.test(raw);
  if (unparsedFailure) errors.push(raw.trim().slice(0, 400));
  return { elaborates: errors.length === 0, errors, warnings, raw };
}

/**
 * Does this reply describe the TOOL failing rather than the STATEMENT failing?
 *
 * A daemon that rejects the call itself — wrong argument name, schema
 * validation, an internal crash — produces text with no Lean diagnostic in it.
 * Read naively that looks like "compilation failed", and the problem gets
 * blamed (and previously, discarded) for what is actually a wiring or
 * infrastructure fault. Anything carrying a real `Line N (Error|Warning)` is a
 * genuine compiler verdict and is never treated as a tool failure.
 */
export function isToolInvocationFailure(text: string): boolean {
  const raw = String(text || '');
  if (/Line\s+\d+\s+\((Error|Warning)\)/i.test(raw)) return false;
  if (/compilation successful/i.test(raw)) return false;
  return /error executing tool|validation error|field required|type=missing|traceback|pydantic|internal server error|not authenticated/i.test(
    raw,
  );
}

// ---------------------------------------------------------------------------
// Re-formalization — repair the STATEMENT, never bin the PROBLEM
// ---------------------------------------------------------------------------
//
// A failed elaboration says the Lean rendering is wrong. It says nothing about
// the mathematics: the problem text, the answer, the insight and (for trapdoor)
// the hidden chain are all still good, and they are the expensive part — the
// Lean statement is a cheap re-derivable view of them. So a compile failure
// feeds the exact compiler errors back and asks for a corrected statement for
// the SAME problem, which also matches the doctrine this pipeline already
// adopted from VHG: nothing valid is ever discarded.

export const MAX_REFORMALIZE_ATTEMPTS = 3;

export const REFORMALIZER_SYSTEM_PROMPT =
  'You are a Lean 4 formalizer. You repair Lean theorem STATEMENTS so they elaborate against Mathlib, without ever altering the mathematical content they encode. Respond with only the requested JSON object.';

/**
 * Ask for a corrected Lean statement for an unchanged problem.
 *
 * `failures` is every (statement, compiler output) pair tried so far, so the
 * model can see which repairs have already been ruled out rather than cycling
 * back to one — the failure mode that made the River Stone refinement loop
 * resubmit the same graph sixteen times.
 */
export function reformalizePrompt(
  problem: string,
  answer: string | number,
  failures: { lean: string; errors: string }[],
): string {
  const history = failures
    .map(
      (f, i) =>
        `--- ATTEMPT ${i + 1} ---\n${f.lean}\n--- COMPILER SAID ---\n${f.errors}`,
    )
    .join('\n\n');

  return `A competition problem has been written and solved. Its Lean 4 formalization does NOT compile. Produce a corrected formalization of the SAME problem.

--- PROBLEM ---
${problem}

--- THE ANSWER (must remain exactly this) ---
${answer}

${history}

YOUR TASK: emit a Lean 4 theorem that (a) states the same mathematical claim about the same problem, (b) still encodes the answer ${answer}, and (c) actually elaborates against Mathlib.

DO NOT change the mathematics. Do not weaken the claim, drop hypotheses, change the answer, or replace the statement with something trivially true (e.g. \`1 = 1\`, or a hypothesis that is never used). A statement that compiles but no longer says what the problem says is a FAILURE, worse than the broken one — it would send a prover after the wrong theorem.

THE MOST COMMON CAUSE, check it first: a value bound as a plain variable and then used as a TYPE. Typeclass search cannot see through a propositional hypothesis, so

    (N : ℕ) (hN : N = 2^100 + 2^50 + 1) ... (x : ZMod N)
      ⇒ failed to synthesize instance ... Fintype (ZMod N)

because nothing tells the elaborator N ≠ 0. Inline the literal at every point where it appears in a TYPE (\`ZMod (2^100 + 2^50 + 1)\`), so instances resolve syntactically. The same trap hits \`Fin n\`, \`Matrix _ n _\`, and any \`Finset.Ico a b\` whose index type is inferred from a cast in the body rather than from the bounds — there, ascribe the bound (\`Finset.Ico (1 : ℕ) n\`).

OTHER RULES:
- ONE single self-contained declaration. Never a separate top-level \`def\`/\`abbrev\` the theorem then references — fold any auxiliary function or recurrence into the theorem's own signature as a bound variable plus hypotheses giving its defining equations.
- Assume an ambient \`import Mathlib\`; emit no import lines.
- End the body with \`:= by sorry\`. You are writing the STATEMENT, not proving it.

Respond with ONLY this JSON object, nothing else:
{"lean":"theorem name : <statement> := by sorry","fix":"<one line: what was actually wrong and what you changed>"}`;
}

/** Pull the corrected statement out of the re-formalizer's JSON reply. */
export function parseReformalized(
  text: string,
): { lean: string; fix: string } | null {
  const raw = String(text || '');
  // Tolerate prose or a ```json fence around the object.
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  try {
    const o = JSON.parse(raw.slice(start, end + 1));
    const lean = typeof o?.lean === 'string' ? o.lean.trim() : '';
    if (!lean) return null;
    return { lean, fix: typeof o?.fix === 'string' ? o.fix : '' };
  } catch {
    return null;
  }
}

/**
 * The user's registered MCP servers, straight from the app's Postgres-backed
 * route. Deliberately NOT lib/mcp/fetch-prover-servers: that one also pings the
 * Python manager to enrich each server with its live tool list, and the whole
 * point here is to need nothing but the bridge. Tool metadata is optional —
 * the bridge falls back to probing each server, which is cheap.
 */
export async function fetchRegisteredServers(
  fetchFn: FetchFn = fetch,
): Promise<ElaborationServer[]> {
  try {
    const r = await fetchFn('/api/mcp/servers');
    if (!r.ok) return [];
    const rows = await r.json();
    if (!Array.isArray(rows)) return [];
    return rows
      .filter((x: any) => x?.url && x?.isActive !== false)
      .map((x: any) => ({ name: String(x.name ?? 'MCP server'), url: String(x.url) }));
  } catch {
    return [];
  }
}

/**
 * Compile the statement on the Lean daemon via the bridge.
 * Throws ElaborationUnavailableError when the check cannot run at all.
 */
export async function checkStatementElaborates(
  lean: string,
  bridgePost: BridgePost,
  fetchFn: FetchFn = fetch,
): Promise<ElaborationVerdict> {
  const servers = await fetchRegisteredServers(fetchFn);
  if (!servers.length) {
    throw new ElaborationUnavailableError(
      'No MCP servers are registered, so there is no Lean daemon to compile against. Add Leak IV under MCP servers, or set Statement check to Off to generate without it.',
    );
  }
  let res: Response;
  try {
    res = await bridgePost('/verify-statement', {
      method: 'POST',
      body: JSON.stringify({
        script: buildElaborationScript(lean),
        mcpServers: servers,
      }),
    });
  } catch (e) {
    throw new ElaborationUnavailableError(
      `Couldn't reach the bridge to run the statement check (${(e as Error)?.message ?? e}). Start the bridge, or set Statement check to Off.`,
    );
  }
  if (res.status === 404) {
    // Older bridge without the endpoint — say so precisely, since the fix is a
    // re-download rather than anything to do with the daemon or the problem.
    throw new ElaborationUnavailableError(
      'This bridge is too old for the statement check (no /verify-statement). Re-download the bridge, or set Statement check to Off.',
    );
  }
  if (!res.ok) {
    throw new ElaborationUnavailableError(
      `The bridge rejected the statement check (HTTP ${res.status}).`,
    );
  }
  const data = await res.json().catch(() => null);
  if (!data?.ok) {
    throw new ElaborationUnavailableError(
      `The Lean daemon couldn't run the statement check: ${data?.error ?? 'unknown error'}`,
    );
  }
  const text = String(data.text ?? '');
  // The daemon answered, but it was the TOOL that failed, not the statement.
  // This must not come back as a verdict: a wrong argument name or a daemon
  // crash would otherwise be reported as "your statement does not elaborate".
  if (isToolInvocationFailure(text)) {
    throw new ElaborationUnavailableError(
      `The Lean daemon rejected the verification call itself, so the statement was never checked: ${text.trim().slice(0, 300)}`,
    );
  }
  const verdict = parseElaborationVerdict(text);
  verdict.serverUrl = data.serverUrl;
  return verdict;
}
