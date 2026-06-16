"use client"

import { useState, useEffect, useRef } from "react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Switch } from "@/components/ui/switch"
import { TrashIcon } from "./icons"
import { toast } from "sonner"
import type { MCPServer } from "@/lib/types/mcp"
import { type MCPTool } from "@/lib/services/mcp-flask-service"
import { useMcpService } from "@/lib/services/mcp-flask-service"
import { except } from "drizzle-orm/mysql-core"
import { useApiClient } from "@/lib/hooks/useApiClient"
import { useSession } from "next-auth/react"

interface MCPServerListProps {
  refreshTrigger?: number
}

interface ExtendedMCPServer extends MCPServer {
  isConnected?: boolean
  tools?: MCPTool[]
  flaskServerId?: string
}

export function MCPServerList({ refreshTrigger }: MCPServerListProps) {
  const [servers, setServers] = useState<ExtendedMCPServer[]>([])
  const [isLoading, setIsLoading] = useState(true)

  const { data: session, status } = useSession();
  
  // THE FIX: Track connections currently in-flight to prevent race conditions
  const connectingServers = useRef<Set<string>>(new Set())

  const mcpFlaskService = useMcpService();
  const apiClient = useApiClient()

  const fetchServers = async () => {
    if (status === "loading") {
      setIsLoading(false);
      return;
    }
    
    if (!session?.user?.hasLeakAccount) {
      console.log("[MCP List] User is unauthenticated or unprovisioned. Skipping background sync.");
      setIsLoading(false); // Make sure your UI doesn't spin forever
      return; 
    }

    console.log("[MCP List] Starting full server fetch sync...")
    setIsLoading(true)
    try {
      const [dbResponse, flaskServers] = await Promise.all([
        apiClient("/api/mcp/servers"),
        mcpFlaskService.getAuthenticatedServers().catch((err) => {
          console.error("[MCP List] Failed to fetch active servers from Python backend:", err)
          return []
        }),
      ])

      if (!dbResponse.ok) throw new Error("Failed to fetch servers from database")
      const dbServers = await dbResponse.json()

      const enhancedServers = await Promise.all(
        dbServers.map(async (server: MCPServer) => {
          const normalizeUrl = (url: string) => url.replace(/\/$/, "")
          let flaskServer = flaskServers.find((fs: any) => normalizeUrl(fs.url) === normalizeUrl(server.url))

          let isConnected = false
          let tools: MCPTool[] = []
          let currentFlaskServerId = flaskServer?.id

          // ==========================================
          // 1. AUTO-RECONNECT LOGIC (Page Refreshes)
          // ==========================================
          if (!flaskServer && server.isActive) {
            // Check the lock: Are we already trying to connect this exact server?
            if (connectingServers.current.has(server.id)) {
              console.log(`[MCP List] Connection for '${server.name}' is already in flight. Skipping duplicate auth.`)
            } else {
              console.log(`[MCP List] Server '${server.name}' is supposed to be active. Auto-reconnecting...`)
              
              // Lock it
              connectingServers.current.add(server.id)
              
              try {
                const authResult = await mcpFlaskService.authenticateServer({
                  name: server.name,
                  url: server.url,
                  authType: server.authType,
                  credentials: server.credentials,
                })

                if (authResult.success) {
                  console.log(`[MCP List] Auto-reconnect successful for ${server.name}!`)
                  isConnected = true
                  tools = authResult.tools || []
                  currentFlaskServerId = authResult.server_id
                }
              } catch (error) {
                console.error(`[MCP List] Auto-reconnect failed for ${server.name}:`, error)
              } finally {
                // Unlock it when done (success or fail)
                connectingServers.current.delete(server.id)
              }
            }
          }
          // ==========================================
          // 2. FETCH TOOLS DIRECTLY (Bypass Fragile Ping)
          // ==========================================
          else if (flaskServer) {
            try {
              tools = await mcpFlaskService.getServerTools(flaskServer.id)
              isConnected = true 
            } catch (error) {
              console.error(`[MCP List] Failed to fetch tools, marking as disconnected:`, error)
              isConnected = false
            }
          }

          return {
            ...server,
            isConnected,
            tools,
            flaskServerId: currentFlaskServerId,
          }
        }),
      )

      setServers(enhancedServers)
    } catch (error) {
      console.error("[MCP List] Complete Error fetching MCP servers:", error)
      toast.error("Failed to load MCP servers")
    } finally {
      setIsLoading(false)
    }
  }

  useEffect(() => {
    fetchServers()
  }, [refreshTrigger])

  const toggleServer = async (serverId: string, isActive: boolean) => {
    try {
      const serverIndex = servers.findIndex((s) => s.id === serverId)
      if (serverIndex === -1) return
      const server = servers[serverIndex]

      let newIsConnected = server.isConnected
      let newTools = server.tools
      let newFlaskServerId = server.flaskServerId

      if (isActive && !server.isConnected) {
        toast.info(`Connecting to ${server.name}...`)
        connectingServers.current.add(server.id)
        
        try {
          const authResult = await mcpFlaskService.authenticateServer({
            name: server.name,
            url: server.url,
            authType: server.authType,
            credentials: server.credentials,
          })
          if (!authResult.success) throw new Error("Failed to connect to MCP server")
          newIsConnected = true
          newTools = authResult.tools || []
          newFlaskServerId = authResult.server_id
        } catch (error) {
          console.error(`[MCP List] Connection failed for ${server.name}:`, error)
          
          throw error
        } finally {
          connectingServers.current.delete(server.id)
        }


        
      } else if (!isActive && server?.flaskServerId) {
        await mcpFlaskService.disconnectServer(server.flaskServerId)
        newIsConnected = false
        newTools = []
        newFlaskServerId = undefined
      }

      const response = await apiClient(`/api/mcp/servers/${serverId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ isActive }),
      })

      if (!response.ok) throw new Error("Failed to update database")

      // don't call fetchServers, it causes double tool mounting
      // await fetchServers()
      
      const updatedServers = [...servers]
      updatedServers[serverIndex] = {
        ...server,
        isActive,
        isConnected: newIsConnected,
        tools: newTools,
        flaskServerId: newFlaskServerId
      }
      
      setServers(updatedServers)

      toast.success(`Server ${isActive ? "connected" : "disconnected"}`)
    } catch (error) {
      console.error("[MCP List] Error toggling server:", error)
      toast.error(error instanceof Error ? error.message : "Failed to toggle server")
      await fetchServers() 
    }
  }

  const deleteServer = async (serverId: string) => {
    if (!confirm("Are you sure you want to delete this MCP server?")) return

    try {
      const server = servers.find((s) => s.id === serverId)
      if (server?.flaskServerId) {
        await mcpFlaskService.disconnectServer(server.flaskServerId)
      }

      const response = await apiClient(`/api/mcp/servers/${serverId}`, { method: "DELETE" })
      if (!response.ok) throw new Error("Failed to delete server")

      setServers(servers.filter((server) => server.id !== serverId))
      toast.success("Server deleted successfully")
    } catch (error) {
      console.error("[MCP List] Error deleting server:", error)
      toast.error("Failed to delete server")
    }
  }

  if (isLoading) {
    return <div className="text-center py-4 text-sm text-muted-foreground">Syncing connections...</div>
  }

  if (servers.length === 0) {
    return (
      <div className="text-center py-8 text-muted-foreground">
        <p>No MCP servers configured yet.</p>
        <p className="text-sm">Add your first server to get started.</p>
      </div>
    )
  }

  return (
    <div className="space-y-4">
      {servers.map((server) => (
        <Card key={server.id}>
          <CardHeader className="pb-3">
            <div className="flex items-center justify-between">
              <div>
                <CardTitle className="text-base">{server.name}</CardTitle>
                <CardDescription className="text-sm">{server.url}</CardDescription>
              </div>
              <div className="flex items-center gap-2">
                <Badge variant={server.isConnected ? "default" : "destructive"}>
                  {server.isConnected ? "Connected" : "Disconnected"}
                </Badge>
                <Badge variant={server.authType === "none" ? "secondary" : "default"}>
                  {server.authType === "none" ? "No Auth" : server.authType.toUpperCase()}
                </Badge>
                <Switch checked={server.isActive} onCheckedChange={(checked) => toggleServer(server.id, checked)} />
              </div>
            </div>
          </CardHeader>
          <CardContent className="pt-0">
            {server.description && <p className="text-sm text-muted-foreground mb-2">{server.description}</p>}
            
            {server.tools && server.tools.length > 0 && (
              <div className="mb-3">
                <p className="text-xs font-medium text-muted-foreground mb-1">Available Tools:</p>
                <div className="flex flex-wrap gap-1">
                  {server.tools.map((tool) => (
                    <Badge key={tool.name} variant="outline" className="text-xs bg-blue-50 text-blue-700 border-blue-200">
                      {tool.name}
                    </Badge>
                  ))}
                </div>
              </div>
            )}
            
            <div className="flex justify-end gap-2">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => deleteServer(server.id)}
                className="text-destructive hover:text-destructive"
              >
                <TrashIcon size={14} />
              </Button>
            </div>
          </CardContent>
        </Card>
      ))}
    </div>
  )
}