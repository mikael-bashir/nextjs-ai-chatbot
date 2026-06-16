"use client";

import { useApiClient } from "../hooks/useApiClient";

export interface MCPServer {
  id: string;
  name: string;
  url: string;
  description: string | null;
  authType: "none" | "bearer" | "oauth" | "apikey";
  credentials: any;
  isActive: boolean;
  userId: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface MCPTool {
  name: string;
  description: string;
  inputSchema: any;
}

export interface MCPAuthResult {
  success: boolean;
  message: string;
  server_id?: string;
  authorization_url?: string;
  tools?: MCPTool[];
}

export interface MCPToolResult {
  success: boolean;
  result?: any;
  error?: string;
}

export function useMcpService() {
  const apiClient = useApiClient();
  const baseUrl = "/api/flask";

  const authenticateServer = async (serverData: {
    name: string;
    url: string;
    authType: string;
    credentials?: any;
  }): Promise<MCPAuthResult> => {
    const response = await apiClient(`${baseUrl}/mcp/start-auth`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(serverData),
    });

    if (response.status === 403 || response.status === 401) throw new Error("Please finish account setup!");
    if (!response.ok) throw new Error(`Authentication failed: ${response.statusText}`);

    return response.json();
  };

  const getServerTools = async (serverId: string): Promise<MCPTool[]> => {
    const response = await apiClient(`${baseUrl}/mcp/servers/${serverId}/tools`);
    
    if (response.status === 403 || response.status === 401) throw new Error("Please finish account setup!");
    if (!response.ok) throw new Error(`Failed to get tools: ${response.statusText}`);
    
    const data = await response.json();
    return data.tools || [];
  };

  const callTool = async (serverId: string, toolName: string, args: any): Promise<MCPToolResult> => {
    const response = await apiClient(`${baseUrl}/mcp/servers/${serverId}/call`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tool_name: toolName, arguments: args }),
    });

    if (response.status === 403 || response.status === 401) throw new Error("Please finish account setup!");
    if (!response.ok) throw new Error(`Tool call failed: ${response.statusText}`);
    
    return response.json();
  };

  const getAuthenticatedServers = async (): Promise<any[]> => {
    const response = await apiClient(`${baseUrl}/mcp/servers`);
    
    if (response.status === 403 || response.status === 401) throw new Error("Please finish account setup!");
    if (!response.ok) throw new Error(`Failed to get servers: ${response.statusText}`);
    
    const data = await response.json();
    return data.servers || [];
  };

  const disconnectServer = async (serverId: string): Promise<void> => {
    const response = await apiClient(`${baseUrl}/mcp/servers/${serverId}`, {
      method: "DELETE",
    });

    if (response.status === 403 || response.status === 401) throw new Error("Please finish account setup!");
    if (!response.ok) throw new Error(`Failed to disconnect server: ${response.statusText}`);
  };

  const saveServer = async (serverData: {
    name: string;
    url: string;
    description: string;
    authType: string;
    credentials?: any;
    flaskServerId: string;
  }): Promise<MCPAuthResult> => {
    const response = await apiClient(`${baseUrl}/mcp/servers`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(serverData),
    });

    if (response.status === 403 || response.status === 401) throw new Error("Please finish account setup!");
    if (!response.ok) throw new Error(`Failed to save server: ${response.statusText}`);
    
    return response.json();
  };

  const pingServer = async (serverId: string): Promise<boolean> => {
    try {
      const response = await apiClient(`${baseUrl}/mcp/servers/${serverId}/ping`);
      if (response.status === 403 || response.status === 401) return false;
      return response.ok;
    } catch {
      return false;
    }
  };

  return {
    authenticateServer,
    getServerTools,
    callTool,
    getAuthenticatedServers,
    disconnectServer,
    saveServer,
    pingServer,
  };
}