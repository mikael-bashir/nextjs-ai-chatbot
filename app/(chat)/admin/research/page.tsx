import Link from 'next/link';
import { redirect } from 'next/navigation';

import { auth } from '@/app/(auth)/auth';
import { isAdminEmail } from '@/lib/admin';
import {
  AdminLeakRiver,
  AdminLeakStronghold,
  AdminLeakUltra,
} from '@/components/leak/admin-research';

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
          Research: Leak River vs Leak Ultra vs Leak Stronghold
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Every verification attempt on the ACG pipeline is auto-recorded here.
          <span className="font-medium text-foreground"> Leak River</span> — the
          blueprint pipeline driven by Grok, in three nested variants (Stone
          control → Gate ledger → Delta ledger+NL seed).
          <span className="font-medium text-foreground"> Leak Ultra</span> — the
          same pipeline driven by the local Claude CLI, so the driver is the
          only difference from Stone.
          <span className="font-medium text-foreground">
            {' '}
            Leak Stronghold
          </span>{' '}
          — the pre-existing Claude strategies. Each table records the Lean
          toolchain that actually certified the run: the architect group runs
          4.32.0 and the original group 4.29.1, so rows from different tables
          are not interchangeable. Export CSV from any table to plot.
        </p>
        <Link
          href="/admin"
          className="mt-3 inline-flex h-[34px] items-center rounded-md border px-3 text-sm font-medium transition-colors hover:bg-muted"
        >
          ← Prover console
        </Link>
      </div>
      <AdminLeakRiver />
      <AdminLeakUltra />
      <AdminLeakStronghold />
    </div>
  );
}
