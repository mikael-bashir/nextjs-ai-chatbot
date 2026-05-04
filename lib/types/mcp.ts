export interface MCPServer {
  id: string
  name: string
  url: string
  description: string | null // Changed from optional string to nullable string to match database
  authType: "none" | "bearer" | "oauth" | "apikey"
  credentials: unknown // Changed to unknown to match database JSON field type
  isActive: boolean
  userId: string // Added userId field that exists in database schema
  createdAt: Date
  updatedAt: Date
  flaskServerId?: string | null
}

export interface MCPTool {
  name: string
  description: string
  inputSchema: any
  serverId: string
}

export interface MCPAuthConfig {
  authType: "none" | "bearer" | "oauth" | "apikey"
  credentials: {
    token?: string
    apiKey?: string
  }
}
