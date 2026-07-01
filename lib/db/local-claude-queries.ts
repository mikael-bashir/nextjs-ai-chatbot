import "server-only"

import { eq } from "drizzle-orm"
import { sql } from "@vercel/postgres"
import { drizzle } from "drizzle-orm/vercel-postgres"
import { localClaudeAgentConfig } from "./schema"
import type { LocalClaudeAgentConfig } from "./schema"
import type { LocalClaudeConfigInput } from "@/lib/types/local-claude"

if (!process.env.POSTGRES_URL) {
  throw new Error("POSTGRES_URL environment variable is not set.")
}

const schema = { localClaudeAgentConfig }
const db = drizzle(sql, { schema })

export async function getLocalClaudeConfig(
  userId: string,
): Promise<LocalClaudeAgentConfig | null> {
  try {
    const [config] = await db
      .select()
      .from(localClaudeAgentConfig)
      .where(eq(localClaudeAgentConfig.userId, userId))
      .limit(1)

    return config || null
  } catch (error) {
    console.error("Failed to get local Claude config:", error)
    throw error
  }
}

// Upsert: one config row per user. Creates on first save, updates thereafter.
export async function saveLocalClaudeConfig(
  userId: string,
  input: LocalClaudeConfigInput,
): Promise<LocalClaudeAgentConfig> {
  const now = new Date()
  const values = {
    binaryPath: input.binaryPath,
    workingDirectory: input.workingDirectory,
    model: input.model,
    permissionMode: input.permissionMode,
    allowedTools: input.allowedTools,
    maxTurns: input.maxTurns,
    timeoutMs: input.timeoutMs,
    systemPromptAppend: input.systemPromptAppend,
    extraArgs: input.extraArgs,
    enabled: input.enabled,
    updatedAt: now,
  }

  try {
    const [saved] = await db
      .insert(localClaudeAgentConfig)
      .values({ ...values, userId, createdAt: now })
      .onConflictDoUpdate({
        target: localClaudeAgentConfig.userId,
        set: values,
      })
      .returning()

    return saved
  } catch (error) {
    console.error("Failed to save local Claude config:", error)
    throw error
  }
}
