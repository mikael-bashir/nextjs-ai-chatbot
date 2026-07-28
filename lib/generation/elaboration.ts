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
// HOW IT RUNS. Entirely on the user's remote Lean daemon, reached through the
// Python MCP connection manager (app/api/index.py) — the same singleton the
// prover and the MCP server list already use, so a server connected in the UI
// is usable here with no extra setup and no local Lean toolchain.

export const ELABORATION_TOOL_NAME = 'verify_full_script';
export const ELABORATION_SCRIPT_ARG = 'script';

// Thrown when the check is enabled but the connection manager has no connected
// server exposing the tool. Kept distinct from a compile failure: this is an
// infrastructure problem the user must fix (connect Leak IV), NOT a verdict on
// the problem, so the caller must surface it in the UI rather than discarding
// the generated problem as if it were malformed.
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
  /** Which MCP server answered, for the console line. */
  serverName?: string;
}

type FetchFn = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

const FLASK = '/api/flask';

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
 * Dig the text payload out of a FastMCP CallToolResult. The Python manager
 * returns `result.dict()`, so the shape is {content: [{type:'text', text}]},
 * but it falls back to `str(result)` for older servers — hence the string case.
 */
export function extractToolText(result: unknown): string {
  if (typeof result === 'string') return result;
  if (!result || typeof result !== 'object') return '';
  const r = result as Record<string, unknown>;
  const content = r.content;
  if (Array.isArray(content)) {
    const parts = content
      .map((c) =>
        c && typeof c === 'object' ? String((c as { text?: unknown }).text ?? '') : '',
      )
      .filter(Boolean);
    if (parts.length) return parts.join('\n');
  }
  if (typeof r.text === 'string') return r.text;
  return JSON.stringify(result);
}

/**
 * Read Leak IV's reply. It reports overall failure whenever ANY diagnostic is
 * present, and a `sorry` counts as a warning — so "compilation failed" alone
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
  // An explicit success banner with no parsed diagnostics is unambiguous.
  const explicitOk = /compilation successful/i.test(raw);
  // Guard against a reply we could not parse at all: if the daemon said it
  // failed and we found no diagnostic lines, treat that as an error rather than
  // silently passing a statement we never actually checked.
  const unparsedFailure =
    !explicitOk && !errors.length && !warnings.length && /failed|error/i.test(raw);
  if (unparsedFailure) errors.push(raw.trim().slice(0, 400));
  return { elaborates: errors.length === 0, errors, warnings, raw };
}

interface ConnectedServer {
  id: string;
  name: string;
}

/**
 * Find a connected MCP server that actually exposes the verification tool.
 *
 * Matching on the TOOL rather than on a server named "Leak IV" is deliberate:
 * the user runs several Leak daemons (XI/XII/XIV) on different toolchains and
 * renames them, so a name match would break the moment a server is relabelled,
 * while the tool name is what we actually depend on.
 */
export async function findElaborationServer(
  fetchFn: FetchFn = fetch,
): Promise<ConnectedServer | null> {
  let servers: Array<Record<string, unknown>> = [];
  try {
    const r = await fetchFn(`${FLASK}/mcp/servers`);
    if (!r.ok) return null;
    const d = await r.json();
    // The manager returns a bare array; tolerate a {servers: [...]} wrapper too.
    servers = Array.isArray(d) ? d : Array.isArray(d?.servers) ? d.servers : [];
  } catch {
    return null;
  }
  for (const s of servers) {
    const id = String(s.id ?? s.server_id ?? '');
    if (!id) continue;
    try {
      const tr = await fetchFn(`${FLASK}/mcp/servers/${encodeURIComponent(id)}/tools`);
      if (!tr.ok) continue;
      const td = await tr.json();
      const tools: Array<Record<string, unknown>> = Array.isArray(td?.tools)
        ? td.tools
        : [];
      const hit = tools.some((t) => {
        const name = String(t?.name ?? '');
        if (name === ELABORATION_TOOL_NAME) return true;
        // Tolerate a renamed tool as long as it verifies a whole script.
        const props = (t?.inputSchema as { properties?: Record<string, unknown> })
          ?.properties;
        return (
          /verify/i.test(name) && !!props && ELABORATION_SCRIPT_ARG in props
        );
      });
      if (hit) return { id, name: String(s.name ?? 'MCP server') };
    } catch {
      /* try the next server */
    }
  }
  return null;
}

/**
 * Compile the statement on the remote daemon and return the verdict.
 * Throws ElaborationUnavailableError when no suitable server is connected.
 */
export async function checkStatementElaborates(
  lean: string,
  fetchFn: FetchFn = fetch,
): Promise<ElaborationVerdict> {
  const server = await findElaborationServer(fetchFn);
  if (!server) {
    throw new ElaborationUnavailableError(
      `No connected MCP server exposes "${ELABORATION_TOOL_NAME}". Connect Leak IV in MCP servers, then generate again — or set Statement check to Off to generate without it.`,
    );
  }
  let res: Response;
  try {
    res = await fetchFn(
      `${FLASK}/mcp/servers/${encodeURIComponent(server.id)}/call`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          tool_name: ELABORATION_TOOL_NAME,
          arguments: { [ELABORATION_SCRIPT_ARG]: buildElaborationScript(lean) },
        }),
      },
    );
  } catch (e) {
    throw new ElaborationUnavailableError(
      `Couldn't reach the MCP connection manager to run the statement check (${(e as Error)?.message ?? e}).`,
    );
  }
  if (!res.ok) {
    throw new ElaborationUnavailableError(
      `${server.name} rejected the statement check (HTTP ${res.status}). It may have disconnected — reconnect it in MCP servers.`,
    );
  }
  const data = await res.json().catch(() => null);
  if (!data?.success) {
    throw new ElaborationUnavailableError(
      `${server.name} failed to run the statement check: ${data?.error ?? 'unknown error'}`,
    );
  }
  const verdict = parseElaborationVerdict(extractToolText(data.result));
  verdict.serverName = server.name;
  return verdict;
}
