import type { NextRequest } from "next/server"
import { auth } from "@/app/(auth)/auth"
import { getLocalClaudeConfig, saveLocalClaudeConfig } from "@/lib/db/local-claude-queries"
import { normalizeLocalClaudeConfigInput } from "@/lib/local-claude/config"
import { DEFAULT_LOCAL_CLAUDE_CONFIG } from "@/lib/types/local-claude"

// Stores the user's non-secret Local Agent run preferences. Execution happens
// entirely in the browser against the user's local bridge — this route never
// touches the CLI. (No `runtime` export: incompatible with `cacheComponents`.)

export async function GET() {
  try {
    const session = await auth()
    if (!session?.user?.id) {
      return new Response("Unauthorized", { status: 401 })
    }

    const row = await getLocalClaudeConfig(session.user.id)
    if (!row) {
      // No saved config yet — return defaults so the UI has a starting point.
      return Response.json({ ...DEFAULT_LOCAL_CLAUDE_CONFIG, id: null })
    }

    return Response.json(row)
  } catch (error) {
    console.error("Error fetching local Claude config:", error)
    return new Response("Internal Server Error", { status: 500 })
  }
}

export async function PUT(request: NextRequest) {
  try {
    const session = await auth()
    if (!session?.user?.id) {
      return new Response("Unauthorized", { status: 401 })
    }

    const body = await request.json().catch(() => null)
    if (!body || typeof body !== "object") {
      return new Response("Invalid request body", { status: 400 })
    }

    const input = normalizeLocalClaudeConfigInput(body as Record<string, unknown>)
    const saved = await saveLocalClaudeConfig(session.user.id, input)

    return Response.json(saved)
  } catch (error) {
    console.error("Error saving local Claude config:", error)
    return new Response("Internal Server Error", { status: 500 })
  }
}
