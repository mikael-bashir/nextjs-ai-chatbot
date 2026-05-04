"use client"

import { useState } from "react"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog"
import { MCPServerDialog } from "./mcp-server-dialogue"
import { MCPServerList } from "./mcp-server-list"
import { Separator } from "@/components/ui/separator"
import { cn } from "@/lib/utils"

interface MCPServerManagementProps {
  className?: string
}

export function MCPServerManagement({ className }: MCPServerManagementProps) {
  const [open, setOpen] = useState(false)
  const [refreshTrigger, setRefreshTrigger] = useState(0)

  const handleServerAdded = () => {
    console.log("[MCP Management] New server added. Triggering list refresh.")
    setRefreshTrigger((prev) => prev + 1)
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm" className={cn("h-[34px]", className)}>
          MCP Servers
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-[600px] max-h-[80vh] overflow-hidden flex flex-col">
        <DialogHeader>
          <DialogTitle>MCP Server Management</DialogTitle>
        </DialogHeader>
        <div className="flex-1 overflow-hidden flex flex-col gap-4">
          <div className="flex justify-end">
            <MCPServerDialog onServerAdded={handleServerAdded} />
          </div>
          <Separator />
          <div className="flex-1 overflow-y-auto">
            <MCPServerList refreshTrigger={refreshTrigger} />
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
