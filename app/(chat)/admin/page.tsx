import { Suspense } from 'react';
import Link from 'next/link';
import { redirect } from 'next/navigation';

import { auth } from '@/app/(auth)/auth';
import { isAdminEmail } from '@/lib/admin';
import { listAdminJobs } from '@/lib/db/leak-queries';
import { AdminPipeline } from '@/components/admin-pipeline';
import { AdminQueueResolver } from '@/components/leak/admin-queue-resolver';
import { AdminAgentLogs } from '@/components/leak/admin-agent-logs';
import { LocalClaudeAgentManagement } from '@/components/local-claude-agent-management';
import { MCPServerManagement } from '@/components/mcp-server-management';

async function AdminContent() {
  const session = await auth();
  if (!isAdminEmail(session?.user?.email)) redirect('/');

  const jobs = await listAdminJobs({ limit: 50 });
  const initialJobs = jobs.map((j) => ({
    id: j.id,
    status: j.status,
    problem: j.problem,
    quotedCredits: j.quotedCredits,
    chargedCredits: j.chargedCredits,
    leasedBy: j.leasedBy,
    createdAt: j.createdAt.toISOString(),
    finishedAt: j.finishedAt ? j.finishedAt.toISOString() : null,
  }));

  return (
    <div className="mx-auto max-w-5xl space-y-8 px-6 py-8">
      <div>
        <p className="font-mono text-xs uppercase tracking-[0.25em] text-muted-foreground">
          Leak · admin
        </p>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight">
          Prover console
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Connect your local Claude bridge and MCP servers, resolve the API
          queue, and generate problems for CompeteMath.
        </p>
        {/* Connect the bridge + register MCP servers; guardrailed proving uses these */}
        <div className="mt-4 flex flex-wrap items-center gap-2">
          <LocalClaudeAgentManagement />
          <MCPServerManagement />
          <Link
            href="/playground"
            className="inline-flex h-[34px] items-center rounded-md border px-3 text-sm font-medium transition-colors hover:bg-muted"
          >
            Playground →
          </Link>
        </div>
      </div>

      {/* Resolve real API-service submissions on the bridge */}
      <AdminQueueResolver initialJobs={initialJobs} />

      {/* Generate + prove + promote problems to CompeteMath */}
      <AdminPipeline />

      {/* Full agent context + outcome for every prover run (admin debugging) */}
      <AdminAgentLogs />
    </div>
  );
}

export default function AdminPage() {
  return (
    <main className="min-h-screen bg-background">
      <Suspense
        fallback={
          <div className="mx-auto max-w-5xl px-6 py-8 text-sm text-muted-foreground">
            Loading admin console…
          </div>
        }
      >
        <AdminContent />
      </Suspense>
    </main>
  );
}
