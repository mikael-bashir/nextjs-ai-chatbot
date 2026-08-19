import { auth } from '@/app/(auth)/auth';
import { isAdminEmail } from '@/lib/admin';
import { listGenerated } from '@/lib/redis';
import { backupProof } from '@/lib/db/proof-backup-queries';

// One-time (idempotent — safe to re-run) sweep: back up every CURRENTLY
// verified item in the generated-problem store, so the batch that is already
// vetted right now is protected before any further re-verify testing (e.g.
// trying river against problems ultra already proved) can touch it. Ongoing
// protection for every verify from here on is automatic — see
// backupBeforeOverwrite() in lib/redis.ts — this endpoint only covers the
// gap for proofs that existed before that guard was added.
async function requireAdmin() {
  const session = await auth();
  return isAdminEmail(session?.user?.email) ? session : null;
}

export async function POST() {
  if (!(await requireAdmin())) {
    return new Response('Forbidden', { status: 403 });
  }
  try {
    const items = await listGenerated();
    let backedUp = 0;
    let certsBackedUp = 0;
    let skipped = 0;
    const errors: string[] = [];
    for (const item of items) {
      const attempts: Array<{ toolchain?: string; proof?: string; strategy?: string | null }> = [];
      if (item.verified && item.proof?.trim())
        attempts.push({ toolchain: item.toolchain, proof: item.proof, strategy: item.enforcer });
      for (const c of item.certs ?? [])
        attempts.push({ toolchain: c.toolchain, proof: c.proof, strategy: c.enforcer });

      const seen = new Set<string>();
      for (const a of attempts) {
        if (!a.toolchain || !a.proof?.trim() || seen.has(a.toolchain)) {
          skipped++;
          continue;
        }
        seen.add(a.toolchain);
        const r = await backupProof({
          lean: item.lean,
          toolchain: a.toolchain,
          proof: a.proof,
          questionTitle: item.questionTitle ?? null,
          strategy: a.strategy ?? null,
        });
        if (r.backedUp) {
          backedUp += attempts[0] === a ? 1 : 0;
          certsBackedUp += attempts[0] !== a ? 1 : 0;
        } else if (r.error) {
          errors.push(`${item.questionTitle || item.id}: ${r.error}`);
        }
      }
    }
    return Response.json({
      ok: true,
      scanned: items.length,
      backedUp,
      certsBackedUp,
      skipped,
      errors: errors.slice(0, 20),
    });
  } catch (error) {
    console.error('Error backfilling proof backups:', error);
    return new Response('Internal Server Error', { status: 500 });
  }
}
