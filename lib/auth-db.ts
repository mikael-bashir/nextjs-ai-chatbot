import { sql } from '@vercel/postgres';

// Edge-safe provisioning check for use in middleware (auth.config `authorized`).
// It uses the Neon HTTP driver (fetch-based) directly, which runs in the edge
// runtime — unlike the full `server-only` queries module. A user is
// "provisioned" iff a row exists in the User table for their id.
//
// Why this exists: the session cookie is minted by the main competemath.com app,
// which never sets the leak-specific `hasLeakAccount` flag (and drops it on every
// re-login). The middleware runs in edge and cannot run the node jwt callback, so
// without a direct DB check it would 403/modal a genuinely provisioned user
// whenever the cookie lacks the flag. Fails closed (false) on any error.
export async function isProvisioned(
  id: string | undefined | null,
): Promise<boolean> {
  if (!id) return false;
  try {
    const { rows } = await sql`SELECT 1 FROM "User" WHERE id = ${id} LIMIT 1`;
    return rows.length > 0;
  } catch {
    return false;
  }
}
