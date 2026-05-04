import { z } from "zod"
import { mcpFlaskService } from "@/lib/services/mcp-flask-service"
import { createTool, type Tool } from "./get-weather"

export interface MCPToolDefinition {
  name: string
  description: string
  inputSchema: any
  serverId: string
}

export function createMCPTool(mcpTool: MCPToolDefinition): Tool {
  // Convert MCP input schema to Zod schema
  const zodSchema = convertMCPSchemaToZod(mcpTool.inputSchema)

  return createTool({
    description: mcpTool.description,
    parameters: zodSchema,
    execute: async (args) => {
      try {
        const result = await mcpFlaskService.callTool(mcpTool.serverId, mcpTool.name, args)

        if (!result.success) {
          throw new Error(result.error || "MCP tool execution failed")
        }

        return result.result
      } catch (error) {
        console.error(`[MCP Tool ${mcpTool.name}] Execution failed:`, error)
        throw error
      }
    },
  })
}

function convertMCPSchemaToZod(schema: any): z.ZodSchema {
  if (!schema || !schema.properties) {
    return z.object({})
  }

  const zodFields: Record<string, z.ZodSchema> = {}

  for (const [key, prop] of Object.entries(schema.properties)) {
    const property = prop as any

    switch (property.type) {
      case "string":
        zodFields[key] = z.string()
        break
      case "number":
        zodFields[key] = z.number()
        break
      case "boolean":
        zodFields[key] = z.boolean()
        break
      case "array":
        zodFields[key] = z.array(z.any())
        break
      case "object":
        zodFields[key] = z.object({}).passthrough()
        break
      default:
        zodFields[key] = z.any()
    }

    // Handle optional fields
    if (!schema.required?.includes(key)) {
      zodFields[key] = zodFields[key].optional()
    }
  }

  return z.object(zodFields)
}

export async function getMCPTools(): Promise<Record<string, any>> {
  try {
    // Get all authenticated MCP servers
    const servers = await mcpFlaskService.getAuthenticatedServers()
    const mcpTools: Record<string, any> = {}

    // Fetch tools from each server
    for (const server of servers) {
      if (!server.isActive) continue

      try {
        const tools = await mcpFlaskService.getServerTools(server.id)

        for (const mcpTool of tools) {
          // Create unique tool name to avoid conflicts
          const toolName = `${server.name}_${mcpTool.name}`.replace(/[^a-zA-Z0-9_]/g, "_")

          mcpTools[toolName] = createMCPTool({
            ...mcpTool,
            serverId: server.id,
          })
        }
      } catch (error) {
        console.error(`[MCP] Failed to fetch tools from server ${server.name}:`, error)
      }
    }

    return mcpTools
  } catch (error) {
    console.error("[MCP] Failed to fetch MCP tools:", error)
    return {}
  }
}
