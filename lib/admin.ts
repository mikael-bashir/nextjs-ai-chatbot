// Client- and server-safe admin check. Admins are identified by email.
export const ADMIN_EMAILS = [
  'bashir.mikael@outlook.com',
  'leakultra@competemath.com',
] as const;

// The single canonical operator account whose OWN registered prover MCP
// servers back the queue worker's fallback lookup (lib/leak/prover-servers.ts)
// when LEAK_PROVER_MCP_CONFIG isn't set. Deliberately NOT "any admin" — that
// lookup resolves one specific account's registered rows, so admitting
// multiple admins here would make it ambiguous whose servers get used.
export const PRIMARY_ADMIN_EMAIL = ADMIN_EMAILS[0];

export function isAdminEmail(email: string | null | undefined): boolean {
  if (!email) return false;
  const lower = email.toLowerCase();
  return ADMIN_EMAILS.some((e) => e.toLowerCase() === lower);
}
