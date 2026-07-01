import type { NextRequest } from "next/server"
import { auth } from "@/app/(auth)/auth"
import { getLocalClaudeConfig } from "@/lib/db/local-claude-queries"
import { normalizeLocalClaudeConfigInput } from "@/lib/local-claude/config"
import { runLocalClaude } from "@/lib/services/local-claude"

export const runtime = "nodejs"

// Runs a single prompt through the user's local Claude Code CLI and returns the
// final text. Uses the user's saved config for model/permissions/tools/timeout.
export async function POST(request: NextRequest) {
  try {
    const session = await auth()
    if (!session?.user?.id) {
      return new Response("Unauthorized", { status: 401 })
    }

    const body = await request.json().catch(() => null)
    const prompt = body?.prompt
    if (typeof prompt !== "string" || prompt.trim().length === 0) {
      return new Response("A non-empty 'prompt' is required", { status: 400 })
    }

    const row = await getLocalClaudeConfig(session.user.id)
    if (!row) {
      return new Response("No local Claude config saved. Configure and test it first.", {
        status: 400,
      })
    }

    const config = normalizeLocalClaudeConfigInput(row as unknown as Record<string, unknown>)
    if (!config.enabled) {
      return new Response("Local Claude Agent is disabled in your settings.", { status: 400 })
    }

    const result = await runLocalClaude(config, prompt)
    return Response.json(result)
  } catch (error) {
    console.error("Error running local Claude agent:", error)
    return new Response("Internal Server Error", { status: 500 })
  }
}
