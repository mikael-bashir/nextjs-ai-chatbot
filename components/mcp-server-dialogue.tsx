"use client"

import type React from "react"

import { useState } from "react"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { PlusIcon } from "./icons"
import { toast } from "sonner"
import type { MCPAuthConfig } from "@/lib/types/mcp"
import { mcpFlaskService } from "@/lib/services/mcp-flask-service"

interface MCPServerDialogProps {
  onServerAdded?: () => void
}

export function MCPServerDialog({ onServerAdded }: MCPServerDialogProps) {
  const [open, setOpen] = useState(false)
  const [isLoading, setIsLoading] = useState(false)
  const [formData, setFormData] = useState({
    name: "",
    url: "",
    description: "",
    authType: "none" as MCPAuthConfig["authType"],
    credentials: {
      token: "",
      apiKey: "",
    },
  })

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setIsLoading(true)

    try {
      const authResult = await mcpFlaskService.authenticateServer({
        name: formData.name,
        url: formData.url,
        authType: formData.authType,
        credentials: formData.authType === "none" ? {} : formData.credentials,
      })

      if (!authResult.success) {
        throw new Error(authResult.message || "Failed to authenticate FastMCP server")
      }

      const saveResponse = await fetch("/api/mcp/servers", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          name: formData.name,
          url: formData.url,
          description: formData.description,
          authType: formData.authType,
          credentials: formData.authType === "none" ? {} : formData.credentials,
          flaskServerId: authResult.server_id || "",
        }),
      })

      if (!saveResponse.ok) {
        throw new Error("Failed to save server to database")
      }

      toast.success("FastMCP server connected and authenticated successfully")
      setOpen(false)
      setFormData({
        name: "",
        url: "",
        description: "",
        authType: "none",
        credentials: { token: "", apiKey: "" },
      })
      onServerAdded?.()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to add FastMCP server")
      console.error("Error adding FastMCP server:", error)
    } finally {
      setIsLoading(false)
    }
  }

  const renderCredentialFields = () => {
    switch (formData.authType) {
      case "bearer":
        return (
          <div className="space-y-2">
            <Label htmlFor="token">Bearer Token</Label>
            <Input
              id="token"
              type="password"
              placeholder="Enter bearer token"
              value={formData.credentials.token}
              onChange={(e) =>
                setFormData({
                  ...formData,
                  credentials: { ...formData.credentials, token: e.target.value },
                })
              }
            />
          </div>
        )
      case "apikey":
        return (
          <div className="space-y-2">
            <Label htmlFor="apiKey">API Key</Label>
            <Input
              id="apiKey"
              type="password"
              placeholder="Enter API key"
              value={formData.credentials.apiKey}
              onChange={(e) =>
                setFormData({
                  ...formData,
                  credentials: { ...formData.credentials, apiKey: e.target.value },
                })
              }
            />
          </div>
        )
      case "oauth":
        return (
          <div className="space-y-4">
            <div className="rounded-lg bg-blue-50 p-4 border border-blue-200">
              <div className="flex items-start space-x-3">
                <div className="flex-shrink-0">
                  <svg className="h-5 w-5 text-blue-400" viewBox="0 0 20 20" fill="currentColor">
                    <path
                      fillRule="evenodd"
                      d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7-4a1 1 0 11-2 0 1 1 0 012 0zM9 9a1 1 0 000 2v3a1 1 0 001 1h1a1 1 0 100-2v-3a1 1 0 00-1-1H9z"
                      clipRule="evenodd"
                    />
                  </svg>
                </div>
                <div>
                  <h3 className="text-sm font-medium text-blue-800">FastMCP OAuth</h3>
                  <div className="mt-2 text-sm text-blue-700">
                    <p>
                      This server uses FastMCP's Dynamic Client Registration (DCR). No manual client credentials needed
                      - authentication will be handled automatically through the OAuth flow.
                    </p>
                  </div>
                </div>
              </div>
            </div>
          </div>
        )
      default:
        return null
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm">
          <PlusIcon size={16} />
          Add FastMCP Server
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-[425px]">
        <DialogHeader>
          <DialogTitle>Add FastMCP Server</DialogTitle>
          <DialogDescription>
            Connect to a FastMCP server to access additional tools and capabilities. FastMCP supports dynamic
            authentication flows.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="name">Server Name</Label>
            <Input
              id="name"
              placeholder="My FastMCP Server"
              value={formData.name}
              onChange={(e) => setFormData({ ...formData, name: e.target.value })}
              required
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="url">Server URL</Label>
            <Input
              id="url"
              type="url"
              placeholder="https://example.com/sse"
              value={formData.url}
              onChange={(e) => setFormData({ ...formData, url: e.target.value })}
              required
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="description">Description (Optional)</Label>
            <Textarea
              id="description"
              placeholder="Describe what this FastMCP server provides..."
              value={formData.description}
              onChange={(e) => setFormData({ ...formData, description: e.target.value })}
              rows={2}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="authType">Authentication Type</Label>
            <Select
              value={formData.authType}
              onValueChange={(value) => {
                if (value) {
                  setFormData({ ...formData, authType: value as MCPAuthConfig["authType"] })
                }
              }}
            >
              <SelectTrigger>
                <SelectValue placeholder="Select authentication type" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">No Authentication</SelectItem>
                <SelectItem value="bearer">Bearer Token</SelectItem>
                <SelectItem value="apikey">API Key</SelectItem>
                <SelectItem value="oauth">FastMCP OAuth (Dynamic)</SelectItem>
              </SelectContent>
            </Select>
          </div>
          {renderCredentialFields()}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={isLoading}>
              {isLoading ? "Connecting..." : "Connect Server"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
