import { auth } from '@/app/(auth)/auth';
import { isAdminEmail } from '@/lib/admin';
import { listProofBackups } from '@/lib/db/proof-backup-queries';

// Read-only view of the durable proof backup — the Postgres-side twin of the
// bridge's ~/.leak-proof-bank.json, for the admin panel's generated-problem
// records rather than the bridge's own run outputs. See lib/redis.ts
// updateGenerated() for what writes here, and backfill/route.ts for the
// one-time sweep over problems that were already verified before this existed.
async function requireAdmin() {
  const session = await auth();
  return isAdminEmail(session?.user?.email) ? session : null;
}

export async function GET() {
  if (!(await requireAdmin())) {
    return new Response('Forbidden', { status: 403 });
  }
  try {
    const entries = await listProofBackups();
    return Response.json({ ok: true, count: entries.length, entries });
  } catch (error) {
    console.error('Error listing proof backups:', error);
    return new Response('Internal Server Error', { status: 500 });
  }
}
