// Fetch the user's active MCP servers AND their live tool inventory from the
// Python MCP manager, so the Lean prover can be handed the EXACT tool names and
// argument keys instead of guessing them. The prover bridge turns each server's
// name into a "mcp__<server>__<tool>" prefix, so knowing the real names live
// (rather than hardcoding "verify_full_script lives on Leak_II") is what stops
// the agent from inventing tool ids like "mcp__Lean_I__verify_full_script".
//
// Degrades gracefully: if the tool list can't be fetched for a server (Python
// backend restarted, stale flaskServerId, etc.) that server is still returned
// with just {name, url} and the prover falls back to server-name-only guidance.

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

export async function fetchProverMcpServers(
  fetchFn: FetchFn = fetch,
): Promise<ProverMcpServer[]> {
  let rows: any[] = [];
  try {
    const r = await fetchFn("/api/mcp/servers");
    if (!r.ok) return [];
    const s = await r.json();
    rows = Array.isArray(s)
      ? s.filter((x: any) => x?.url && x?.name && x?.isActive !== false)
      : [];
  } catch {
    return [];
  }

  return Promise.all(
    rows.map(async (x: any): Promise<ProverMcpServer> => {
      const base: ProverMcpServer = { name: x.name, url: x.url };
      if (!x.flaskServerId) return base;
      try {
        const tr = await fetchFn(`/api/flask/mcp/servers/${x.flaskServerId}/tools`);
        if (tr.ok) {
          const td = await tr.json();
          const tools: ProverMcpTool[] = (td?.tools || [])
            .map((t: any) => ({
              name: t?.name,
              args: Object.keys(t?.inputSchema?.properties || {}),
            }))
            .filter((t: any) => t.name);
          if (tools.length) base.tools = tools;
        }
      } catch {
        /* live tools unavailable — return {name, url} only */
      }
      return base;
    }),
  );
}
