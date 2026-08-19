import { Suspense } from 'react';
import { redirect } from 'next/navigation';

import { auth } from '@/app/(auth)/auth';
import { isAdminEmail } from '@/lib/admin';
import { listApiKeys } from '@/lib/db/leak-queries';
import { getOrCreateCreditBalance } from '@/lib/db/queries';
import { DashboardClient } from '@/components/leak/dashboard-client';

// Session + DB reads are dynamic; under cacheComponents they must live inside a
// Suspense boundary so the static shell can render and this streams in.
async function DashboardContent() {
  const session = await auth();
  if (!session?.user?.id) redirect('/login');

  const [keys, balance] = await Promise.all([
    listApiKeys({ userId: session.user.id }),
    getOrCreateCreditBalance({
      userId: session.user.id,
      email: session.user.email,
    }),
  ]);

  const safeKeys = keys.map((k) => ({
    id: k.id,
    name: k.name,
    prefix: k.prefix,
    lastUsedAt: k.lastUsedAt ? k.lastUsedAt.toISOString() : null,
    createdAt: k.createdAt.toISOString(),
  }));

  return (
    <DashboardClient
      initialKeys={safeKeys}
      balance={balance}
      userName={session.user.name ?? session.user.email ?? 'there'}
      isAdmin={isAdminEmail(session.user.email)}
    />
  );
}

export default function DashboardPage() {
  return (
    <Suspense
      fallback={
        <div className="mx-auto max-w-3xl px-6 py-16 text-sm text-muted-foreground">
          Loading dashboard…
        </div>
      }
    >
      <DashboardContent />
    </Suspense>
  );
}
