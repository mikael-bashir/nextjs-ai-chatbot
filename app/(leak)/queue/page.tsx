import { Suspense } from 'react';
import { redirect } from 'next/navigation';

import { auth } from '@/app/(auth)/auth';
import { isAdminEmail } from '@/lib/admin';
import { listAdminJobs } from '@/lib/db/leak-queries';
import { AdminQueueClient } from '@/components/leak/admin-queue-client';

async function QueueContent() {
  const session = await auth();
  if (!isAdminEmail(session?.user?.email)) redirect('/');

  const jobs = await listAdminJobs({ limit: 50 });
  const initial = jobs.map((j) => ({
    id: j.id,
    status: j.status,
    problem: j.problem,
    quotedCredits: j.quotedCredits,
    chargedCredits: j.chargedCredits,
    leasedBy: j.leasedBy,
    createdAt: j.createdAt.toISOString(),
    finishedAt: j.finishedAt ? j.finishedAt.toISOString() : null,
  }));

  return <AdminQueueClient initialJobs={initial} />;
}

export default function QueuePage() {
  return (
    <Suspense
      fallback={
        <div className="mx-auto max-w-3xl px-6 py-16 text-sm text-muted-foreground">
          Loading queue…
        </div>
      }
    >
      <QueueContent />
    </Suspense>
  );
}
