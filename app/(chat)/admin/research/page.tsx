import Link from 'next/link';
import { redirect } from 'next/navigation';

import { auth } from '@/app/(auth)/auth';
import { isAdminEmail } from '@/lib/admin';
import { AdminLeakRiver, AdminLeakStronghold } from '@/components/leak/admin-research';

export default async function ResearchPage() {
  const session = await auth();
  if (!isAdminEmail(session?.user?.email)) redirect('/');

  return (
    <div className="mx-auto max-w-5xl space-y-6 px-6 py-8">
      <div>
        <p className="font-mono text-xs uppercase tracking-[0.25em] text-muted-foreground">
          Leak · admin
        </p>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight">
          Research: Leak River vs Leak Stronghold
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Every verification attempt on the ACG pipeline is auto-recorded
          here — Leak River for the architect (blueprint) strategy, Leak
          Stronghold for every Claude-driven strategy. Export CSV from either
          table to plot.
        </p>
        <Link
          href="/admin"
          className="mt-3 inline-flex h-[34px] items-center rounded-md border px-3 text-sm font-medium transition-colors hover:bg-muted"
        >
          ← Prover console
        </Link>
      </div>
      <AdminLeakRiver />
      <AdminLeakStronghold />
    </div>
  );
}
