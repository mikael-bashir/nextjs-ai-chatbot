import "server-only"

import { and, desc, eq } from "drizzle-orm"
import { sql } from "@vercel/postgres"
import { drizzle } from "drizzle-orm/vercel-postgres"
import { mcpServers } from "./schema"
import type { MCPServer } from "@/lib/types/mcp"

if (!process.env.POSTGRES_URL) {
  throw new Error("POSTGRES_URL environment variable is not set.")
}

const schema = {
  mcpServers,
}

const db = drizzle(sql, { schema })

export async function getMCPServers(userId: string): Promise<MCPServer[]> {
  try {
    const servers = await db
      .select()
      .from(mcpServers)
      .where(eq(mcpServers.userId, userId))
      .orderBy(desc(mcpServers.createdAt))

    return servers
  } catch (error) {
    console.error("Failed to get MCP servers:", error)
    return []
  }
}

export async function getMCPServerById(id: string, userId?: string): Promise<MCPServer | null> {
  try {
    const conditions = userId ? and(eq(mcpServers.id, id), eq(mcpServers.userId, userId)) : eq(mcpServers.id, id)

    const [server] = await db.select().from(mcpServers).where(conditions).limit(1)

    return server || null
  } catch (error) {
    console.error("Failed to get MCP server:", error)
    return null
  }
}

export async function saveMCPServer(server: Omit<MCPServer, "createdAt" | "updatedAt"> & { userId: string }) {
  try {
    const now = new Date()
    const [savedServer] = await db
      .insert(mcpServers)
      .values({
        ...server,
        createdAt: now,
        updatedAt: now,
      })
      .returning()

    return savedServer
  } catch (error) {
    console.error("Failed to save MCP server:", error)
    throw error
  }
}

export async function updateMCPServer(id: string, updates: Partial<MCPServer>, userId?: string) {
  try {
    const conditions = userId ? and(eq(mcpServers.id, id), eq(mcpServers.userId, userId)) : eq(mcpServers.id, id)

    const [updatedServer] = await db
      .update(mcpServers)
      .set({
        ...updates,
        updatedAt: new Date(),
      })
      .where(conditions)
      .returning()

    return updatedServer
  } catch (error) {
    console.error("Failed to update MCP server:", error)
    throw error
  }
}

export async function deleteMCPServer(id: string, userId?: string) {
  try {
    const conditions = userId ? and(eq(mcpServers.id, id), eq(mcpServers.userId, userId)) : eq(mcpServers.id, id)

    const [deletedServer] = await db.delete(mcpServers).where(conditions).returning()

    return deletedServer
  } catch (error) {
    console.error("Failed to delete MCP server:", error)
    throw error
  }
}

export async function getMCPServerByFlaskId(flaskServerId: string, userId: string): Promise<MCPServer | null> {
  try {
    const [server] = await db
      .select()
      .from(mcpServers)
      .where(and(eq(mcpServers.flaskServerId, flaskServerId), eq(mcpServers.userId, userId)))
      .limit(1)

    return server || null
  } catch (error) {
    console.error("Failed to get MCP server by Flask ID:", error)
    return null
  }
}
