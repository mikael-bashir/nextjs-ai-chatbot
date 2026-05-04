"use client"

import { Switch } from "@/components/ui/switch"
import { Label } from "@/components/ui/label"

interface OrchestrationToggleProps {
  value: boolean
  onChange: (value: boolean) => void
}

export function OrchestrationToggle({ value, onChange }: OrchestrationToggleProps) {
  return (
    <div className="flex items-center space-x-2">
      <Switch id="orchestration-mode" checked={value} onCheckedChange={onChange} />
      <Label htmlFor="orchestration-mode" className="text-sm">
        {value ? "LangChain + Grok" : "AI SDK"}
      </Label>
    </div>
  )
}
