import Link from 'next/link';
import { redirect } from 'next/navigation';

import { auth } from '@/app/(auth)/auth';
import { isAdminEmail } from '@/lib/admin';
import { LiveSyncConsole } from '@/components/live-sync/live-sync-console';

export default async function PushProvePage() {
  const session = await auth();
  if (!isAdminEmail(session?.user?.email)) redirect('/');

  return (
    <div className="mx-auto max-w-5xl space-y-6 px-6 py-8">
      <div>
        <p className="font-mono text-xs uppercase tracking-[0.25em] text-muted-foreground">
          Leak · admin
        </p>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight">
          Push prove
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Attach a proof to a problem that&apos;s already live on CompeteMath —
          for anything promoted before it was proven.
        </p>
        <Link
          href="/admin"
          className="mt-3 inline-flex h-[34px] items-center rounded-md border px-3 text-sm font-medium transition-colors hover:bg-muted"
        >
          ← Prover console
        </Link>
      </div>
      <LiveSyncConsole />
    </div>
  );
}
