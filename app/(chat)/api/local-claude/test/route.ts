import type { NextRequest } from "next/server"
import { auth } from "@/app/(auth)/auth"
import { getLocalClaudeConfig } from "@/lib/db/local-claude-queries"
import { normalizeLocalClaudeConfigInput } from "@/lib/local-claude/config"
import { testLocalClaude } from "@/lib/services/local-claude"
import {
  DEFAULT_LOCAL_CLAUDE_CONFIG,
  type LocalClaudeConfigInput,
} from "@/lib/types/local-claude"

export const runtime = "nodejs"

// Runs the layered setup check. Accepts an optional config in the body so the
// user can test unsaved edits from the form; otherwise uses the saved config.
export async function POST(request: NextRequest) {
  try {
    const session = await auth()
    if (!session?.user?.id) {
      return new Response("Unauthorized", { status: 401 })
    }

    const body = await request.json().catch(() => null)

    let input: LocalClaudeConfigInput
    if (body && typeof body === "object" && Object.keys(body).length > 0) {
      input = normalizeLocalClaudeConfigInput(body as Record<string, unknown>)
    } else {
      const row = await getLocalClaudeConfig(session.user.id)
      input = row
        ? normalizeLocalClaudeConfigInput(row as unknown as Record<string, unknown>)
        : DEFAULT_LOCAL_CLAUDE_CONFIG
    }

    const result = await testLocalClaude(input)
    return Response.json(result)
  } catch (error) {
    console.error("Error testing local Claude setup:", error)
    return new Response("Internal Server Error", { status: 500 })
  }
}
