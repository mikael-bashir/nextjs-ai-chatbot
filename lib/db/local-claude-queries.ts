import "server-only"

import { eq, sql as dsql } from "drizzle-orm"
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

// This deployment builds with a dummy POSTGRES_URL and starts with `node
// server.js` — it never runs `db:migrate`. Like the existing MCPServer table,
// new tables are otherwise created only by a manual `db:push`. To keep this
// feature self-contained, ensure the table exists on first use. Idempotent.
let tableEnsured = false
async function ensureTable(): Promise<void> {
  if (tableEnsured) return
  await db.execute(
    dsql.raw(`
      CREATE TABLE IF NOT EXISTS "LocalClaudeAgentConfig" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
        "userId" uuid NOT NULL REFERENCES "User"("id"),
        "binaryPath" varchar(1024) DEFAULT 'claude' NOT NULL,
        "workingDirectory" text,
        "model" varchar(128),
        "permissionMode" varchar DEFAULT 'default' NOT NULL,
        "allowedTools" text,
        "maxTurns" integer,
        "timeoutMs" integer DEFAULT 120000 NOT NULL,
        "systemPromptAppend" text,
        "extraArgs" json,
        "enabled" boolean DEFAULT true NOT NULL,
        "createdAt" timestamp NOT NULL,
        "updatedAt" timestamp NOT NULL,
        CONSTRAINT "LocalClaudeAgentConfig_userId_unique" UNIQUE("userId")
      );
    `),
  )
  tableEnsured = true
}

export async function getLocalClaudeConfig(
  userId: string,
): Promise<LocalClaudeAgentConfig | null> {
  try {
    await ensureTable()
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
    await ensureTable()
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
