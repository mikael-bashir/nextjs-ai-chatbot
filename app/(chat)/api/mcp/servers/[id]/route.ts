import type { NextRequest } from "next/server"
import { auth } from "@/app/(auth)/auth"
import { updateMCPServer, deleteMCPServer, getMCPServerById } from "@/lib/db/mcp-queries"

export async function PATCH(request: NextRequest, { params }: { params: { id: string } }) {
  try {
    const session = await auth()
    if (!session?.user?.id) {
      return new Response("Unauthorized", { status: 401 })
    }

    const body = await request.json()
    const { isActive, flaskServerId } = body

    const { id } = await params
    const updatedServer = await updateMCPServer(id, {
      isActive,
      flaskServerId,
      updatedAt: new Date(),
    })

    if (!updatedServer) {
      return new Response("Server not found", { status: 404 })
    }

    return Response.json(updatedServer)
  } catch (error) {
    console.error("Error updating MCP server:", error)
    return new Response("Internal Server Error", { status: 500 })
  }
}

export async function DELETE(request: NextRequest, { params }: { params: { id: string } }) {
  try {
    const session = await auth()
    if (!session?.user?.id) {
      return new Response("Unauthorized", { status: 401 })
    }

    const { id } = await params
    const server = await getMCPServerById(id)
    if (!server || server.userId !== session.user.id) {
      return new Response("Server not found", { status: 404 })
    }

    await deleteMCPServer(id)
    return new Response(null, { status: 204 })
  } catch (error) {
    console.error("Error deleting MCP server:", error)
    return new Response("Internal Server Error", { status: 500 })
  }
}
