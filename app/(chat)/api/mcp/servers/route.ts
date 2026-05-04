import type { NextRequest } from "next/server"
import { auth } from "@/app/(auth)/auth"
// import { getMCPServers, saveMCPServer } from "@/lib/db/mcp-queries"
import { getMCPServers, saveMCPServer } from "@/lib/db/mcp-queries"
import { generateUUID } from "@/lib/utils"

export async function GET() {
  try {
    const session = await auth()
    if (!session?.user?.id) {
      return new Response("Unauthorized", { status: 401 })
    }

    const servers = await getMCPServers(session.user.id)
    return Response.json(servers)
  } catch (error) {
    console.error("Error fetching MCP servers:", error)
    return new Response("Internal Server Error", { status: 500 })
  }
}

export async function POST(request: NextRequest) {
  try {
    const session = await auth()
    if (!session?.user?.id) {
      return new Response("Unauthorized", { status: 401 })
    }

    const body = await request.json()
    const { name, url, description, authType, credentials, flaskServerId } = body

    if (!name || !url) {
      return new Response("Name and URL are required", { status: 400 })
    }

    // Basic URL validation
    try {
      new URL(url)
    } catch {
      return new Response("Invalid URL format", { status: 400 })
    }

    const server = await saveMCPServer({
      id: generateUUID(),
      name,
      url,
      description: description || null,
      authType: authType || "none",
      credentials: credentials || {},
      flaskServerId: flaskServerId || null,
      isActive: true,
      userId: session.user.id,
    })

    return Response.json(server, { status: 201 })
  } catch (error) {
    console.error("Error creating MCP server:", error)
    return new Response("Internal Server Error", { status: 500 })
  }
}
