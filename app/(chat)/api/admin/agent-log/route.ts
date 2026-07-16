import type { NextRequest } from 'next/server';
import { auth } from '@/app/(auth)/auth';
import { isAdminEmail } from '@/lib/admin';
import { createAgentRunLog, listAgentRunLogs } from '@/lib/db/leak-queries';

// Admin-only debug log of prover runs: the FULL context handed to the agent
// (system prompt, MCP inventory, theorem, model) + outcome. Writing is silently
// gated to admins, so the client can always "log" and it's a no-op otherwise.
async function requireAdmin() {
  const session = await auth();
  return isAdminEmail(session?.user?.email) ? session : null;
}

export async function GET() {
  if (!(await requireAdmin())) {
    return new Response('Forbidden', { status: 403 });
  }
  const items = await listAgentRunLogs(100);
  return Response.json({ items });
}

export async function POST(request: NextRequest) {
  const session = await requireAdmin();
  // Not an admin → do nothing, but don't error the prove flow. 204.
  if (!session) return new Response(null, { status: 204 });

  const body = await request.json().catch(() => null);
  if (!body || typeof body.theorem !== 'string') {
    return new Response('theorem required', { status: 400 });
  }
  try {
    const row = await createAgentRunLog({
      userId: session.user?.id ?? null,
      source: typeof body.source === 'string' ? body.source : 'playground',
      theorem: body.theorem,
      model: body.model ?? null,
      prompt: body.prompt ?? null,
      mcpServers: body.mcpServers ?? null,
      verified: typeof body.verified === 'boolean' ? body.verified : null,
      proof: body.proof ?? null,
      finalText: body.finalText ?? null,
      metrics: body.metrics ?? null,
      // The full activity flow (ProverEvent[]); only accept an array.
      events: Array.isArray(body.events) ? body.events : null,
    });
    return Response.json({ id: row.id });
  } catch (error) {
    console.error('agent-log insert failed:', error);
    return new Response('Internal Server Error', { status: 500 });
  }
}
