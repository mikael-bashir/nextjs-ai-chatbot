import 'server-only';

import { and, eq } from 'drizzle-orm';
import { sql as vercelSql } from '@vercel/postgres';
import { drizzle } from 'drizzle-orm/vercel-postgres';

import { mcpServers, user } from '@/lib/db/schema';
import { ADMIN_EMAIL } from '@/lib/admin';

const db = drizzle(vercelSql, { schema: { mcpServers, user } });

// The bridge's runProve() wants an array of { name, url } — the same shape the
// existing /prove flow feeds it via fetchProverMcpServers.
export interface ProverMcpServer {
  name: string;
  url: string;
}

/**
 * The hard-set Leak prover MCP servers (Leak_I search, Leak_II Lean daemon)
 * that a queue worker's direct claude+MCP run should drive. Single source of
 * truth, resolved in priority order:
 *
 *   1. LEAK_PROVER_MCP_CONFIG — a JSON array of { name, url }. Use this to pin
 *      the servers explicitly (they rarely change).
 *   2. Otherwise the operator's own registered, active MCPServer rows — the
 *      exact rows the interactive /prove flow already uses. Zero re-config:
 *      whatever Leak_I/Leak_II you registered in the app is what the worker gets.
 */
export async function getProverMcpServers(): Promise<ProverMcpServer[]> {
  const raw = process.env.LEAK_PROVER_MCP_CONFIG;
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        return parsed
          .filter((s) => s?.name && s?.url)
          .map((s) => ({ name: String(s.name), url: String(s.url) }));
      }
    } catch {
      // Malformed env — fall through to the DB source rather than failing leases.
    }
  }

  const [admin] = await db
    .select({ id: user.id })
    .from(user)
    .where(eq(user.email, ADMIN_EMAIL))
    .limit(1);
  if (!admin) return [];

  return db
    .select({ name: mcpServers.name, url: mcpServers.url })
    .from(mcpServers)
    .where(and(eq(mcpServers.userId, admin.id), eq(mcpServers.isActive, true)));
}
