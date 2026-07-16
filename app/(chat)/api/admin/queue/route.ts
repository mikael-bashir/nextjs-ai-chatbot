import { auth } from '@/app/(auth)/auth';
import { isAdminEmail } from '@/lib/admin';
import { listAdminJobs } from '@/lib/db/leak-queries';

// GET /api/admin/queue — recent real jobs for the admin resolution console.
export async function GET() {
  const session = await auth();
  if (!isAdminEmail(session?.user?.email)) {
    return Response.json({ error: 'forbidden' }, { status: 403 });
  }

  const jobs = await listAdminJobs({ limit: 50 });
  return Response.json({
    jobs: jobs.map((j) => ({
      id: j.id,
      status: j.status,
      problem: j.problem,
      pricingClass: j.pricingClass,
      quotedCredits: j.quotedCredits,
      chargedCredits: j.chargedCredits,
      leasedBy: j.leasedBy,
      reservedFor: j.reservedFor ?? null,
      createdAt: j.createdAt,
      finishedAt: j.finishedAt,
    })),
  });
}
