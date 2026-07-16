import { Suspense } from 'react';
import { redirect } from 'next/navigation';

import { auth } from '@/app/(auth)/auth';
import { isAdminEmail } from '@/lib/admin';
import { ProverPlayground } from '@/components/prover/prover-playground';
import { LocalClaudeAgentManagement } from '@/components/local-claude-agent-management';
import { MCPServerManagement } from '@/components/mcp-server-management';

async function PlaygroundContent() {
  const session = await auth();
  // Uses the operator's local bridge, so it's admin-only for now.
  if (!isAdminEmail(session?.user?.email)) redirect('/');

  return (
    <div className="mx-auto max-w-3xl px-6 py-12">
      <p className="font-mono text-xs uppercase tracking-[0.25em] text-muted-foreground">
        Leak · playground
      </p>
      <h1 className="mt-1 text-2xl font-semibold tracking-tight">
        Message the prover
      </h1>
      <p className="mt-1 mb-4 text-sm text-muted-foreground">
        Send a statement to your bridge and watch every step — thinking, tool
        calls, results, and the final verification.
      </p>
      <div className="mb-6 flex flex-wrap items-center gap-2">
        <LocalClaudeAgentManagement />
        <MCPServerManagement />
      </div>
      <ProverPlayground />
    </div>
  );
}

export default function PlaygroundPage() {
  return (
    <Suspense
      fallback={
        <div className="mx-auto max-w-3xl px-6 py-12 text-sm text-muted-foreground">
          Loading playground…
        </div>
      }
    >
      <PlaygroundContent />
    </Suspense>
  );
}
