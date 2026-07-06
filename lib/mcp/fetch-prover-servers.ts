// Fetch the user's active MCP servers AND their live tool inventory from the
// Python MCP manager, so the Lean prover can be handed the EXACT tool names and
// argument keys instead of guessing them. The prover bridge turns each server's
// name into a "mcp__<server>__<tool>" prefix, so knowing the real names live
// (rather than hardcoding "verify_full_script lives on Leak_II") is what stops
// the agent from inventing tool ids and shotgunning ToolSearch across guesses.
//
// KEY: the Python manager only has a server's tools cached once it has CONNECTED
// to it. So we first trigger the manager's connect/sync routine for any active
// server that isn't currently connected (the same auto-reconnect the MCP server
// list does), THEN read the inventory. Without this, a fresh page/agent run gets
// an empty tool list and the prompt falls back to guessing.
//
// Degrades gracefully: if the Python backend is unreachable, a server is still
// returned with just {name, url} and the prover uses server-name-only guidance.

export interface ProverMcpTool {
  name: string;
  args: string[];
}

export interface ProverMcpServer {
  name: string;
  url: string;
  tools?: ProverMcpTool[];
}

type FetchFn = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

const normUrl = (u: string) => String(u || '').replace(/\/$/, '');

function toProverTools(tools: any[]): ProverMcpTool[] {
  return (tools || [])
    .map((t: any) => ({
      name: t?.name,
      args: Object.keys(t?.inputSchema?.properties || {}),
    }))
    .filter((t: any) => t.name);
}

export async function fetchProverMcpServers(
  fetchFn: FetchFn = fetch,
): Promise<ProverMcpServer[]> {
  // 1. The user's registered servers (name/url/auth/credentials) from our DB…
  let rows: any[] = [];
  try {
    const r = await fetchFn('/api/mcp/servers');
    if (!r.ok) return [];
    const s = await r.json();
    rows = Array.isArray(s)
      ? s.filter((x: any) => x?.url && x?.name && x?.isActive !== false)
      : [];
  } catch {
    return [];
  }
  if (!rows.length) return [];

  // 2. …and which servers the Python MCP manager currently has connected.
  let connected: any[] = [];
  try {
    const r = await fetchFn('/api/flask/mcp/servers');
    if (r.ok) {
      const d = await r.json();
      connected = Array.isArray(d?.servers) ? d.servers : [];
    }
  } catch {
    /* Python backend unreachable — reconnect attempts below will no-op */
  }

  // 3. For each active server: read tools if already connected, otherwise
  //    trigger the connect/sync routine (start-auth) — which returns the tools.
  return Promise.all(
    rows.map(async (row: any): Promise<ProverMcpServer> => {
      const base: ProverMcpServer = { name: row.name, url: row.url };
      const match = connected.find(
        (c: any) => normUrl(c.url) === normUrl(row.url),
      );
      try {
        if (match?.id) {
          const tr = await fetchFn(`/api/flask/mcp/servers/${match.id}/tools`);
          if (tr.ok) {
            const td = await tr.json();
            const tools = toProverTools(td?.tools);
            if (tools.length) base.tools = tools;
          }
        } else {
          // Not connected — sync it now. The manager reuses an existing session
          // if one is already open, so this is safe to call each run.
          const ar = await fetchFn('/api/flask/mcp/start-auth', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              name: row.name,
              url: row.url,
              authType: row.authType || 'none',
              credentials: row.credentials,
            }),
          });
          if (ar.ok) {
            const ad = await ar.json();
            const tools = toProverTools(ad?.tools);
            if (tools.length) base.tools = tools;
          }
        }
      } catch {
        /* leave {name,url} — prover falls back to server-name guidance */
      }
      return base;
    }),
  );
}
