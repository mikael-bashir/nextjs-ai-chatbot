import Link from 'next/link';
import { redirect } from 'next/navigation';

import { auth } from '@/app/(auth)/auth';
import { isAdminEmail } from '@/lib/admin';
import { BenchmarkConsole } from '@/components/benchmark/benchmark-console';

export default async function BenchmarkPage() {
  const session = await auth();
  if (!isAdminEmail(session?.user?.email)) redirect('/');

  return (
    <div className="mx-auto max-w-5xl space-y-6 px-6 py-8">
      <div>
        <p className="font-mono text-xs uppercase tracking-[0.25em] text-muted-foreground">
          Leak · admin
        </p>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight">
          Capability benchmark
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Measure Leak against a standard Lean 4 proving benchmark —
          resumable across sessions, so a Claude Max usage limit just means
          clicking Resume later.
        </p>
        <Link
          href="/admin"
          className="mt-3 inline-flex h-[34px] items-center rounded-md border px-3 text-sm font-medium transition-colors hover:bg-muted"
        >
          ← Prover console
        </Link>
      </div>
      <BenchmarkConsole />
    </div>
  );
}
