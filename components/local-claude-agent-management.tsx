"use client"

import { useEffect, useState } from "react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Switch } from "@/components/ui/switch"
import { Separator } from "@/components/ui/separator"
import { Badge } from "@/components/ui/badge"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { cn } from "@/lib/utils"
import {
  DEFAULT_LOCAL_CLAUDE_CONFIG,
  type LocalClaudeConfigInput,
  type LocalClaudePermissionMode,
  type LocalClaudeRunResult,
  type LocalClaudeTestResult,
} from "@/lib/types/local-claude"

interface LocalClaudeAgentManagementProps {
  className?: string
}

const PERMISSION_MODE_OPTIONS: {
  value: LocalClaudePermissionMode
  label: string
}[] = [
  { value: "default", label: "default — prompt on sensitive actions" },
  { value: "acceptEdits", label: "acceptEdits — auto-accept file edits" },
  { value: "plan", label: "plan — read-only planning, no changes" },
  { value: "bypassPermissions", label: "bypassPermissions — allow everything" },
]

// The extraArgs field is edited as a single string; split on whitespace.
function parseExtraArgs(value: string): string[] {
  return value.trim().length > 0 ? value.trim().split(/\s+/) : []
}

export function LocalClaudeAgentManagement({ className }: LocalClaudeAgentManagementProps) {
  const [open, setOpen] = useState(false)
  const [config, setConfig] = useState<LocalClaudeConfigInput>(DEFAULT_LOCAL_CLAUDE_CONFIG)
  const [extraArgsText, setExtraArgsText] = useState("")
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<LocalClaudeTestResult | null>(null)

  const [prompt, setPrompt] = useState("")
  const [running, setRunning] = useState(false)
  const [runResult, setRunResult] = useState<LocalClaudeRunResult | null>(null)

  // Load the saved config whenever the dialog opens.
  useEffect(() => {
    if (!open) return
    setLoading(true)
    fetch("/api/local-claude/config")
      .then((res) => {
        if (!res.ok) throw new Error("Failed to load config")
        return res.json()
      })
      .then((data) => {
        const next: LocalClaudeConfigInput = {
          binaryPath: data.binaryPath ?? DEFAULT_LOCAL_CLAUDE_CONFIG.binaryPath,
          workingDirectory: data.workingDirectory ?? null,
          model: data.model ?? null,
          permissionMode: data.permissionMode ?? "default",
          allowedTools: data.allowedTools ?? null,
          maxTurns: data.maxTurns ?? null,
          timeoutMs: data.timeoutMs ?? DEFAULT_LOCAL_CLAUDE_CONFIG.timeoutMs,
          systemPromptAppend: data.systemPromptAppend ?? null,
          extraArgs: Array.isArray(data.extraArgs) ? data.extraArgs : [],
          enabled: data.enabled ?? true,
        }
        setConfig(next)
        setExtraArgsText(next.extraArgs.join(" "))
      })
      .catch(() => toast.error("Could not load your Local Claude config."))
      .finally(() => setLoading(false))
  }, [open])

  // Assemble the config payload from current form state.
  const buildPayload = (): LocalClaudeConfigInput => ({
    ...config,
    extraArgs: parseExtraArgs(extraArgsText),
  })

  const handleSave = async () => {
    setSaving(true)
    try {
      const res = await fetch("/api/local-claude/config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(buildPayload()),
      })
      if (!res.ok) throw new Error(await res.text())
      toast.success("Configuration saved.")
    } catch (error) {
      toast.error(`Save failed: ${error instanceof Error ? error.message : "unknown error"}`)
    } finally {
      setSaving(false)
    }
  }

  const handleTest = async () => {
    setTesting(true)
    setTestResult(null)
    try {
      // Test the current (possibly unsaved) form values.
      const res = await fetch("/api/local-claude/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(buildPayload()),
      })
      if (!res.ok) throw new Error(await res.text())
      const data: LocalClaudeTestResult = await res.json()
      setTestResult(data)
      if (data.ok) toast.success("Local Claude is set up correctly.")
      else toast.error("Setup check found a problem — see details below.")
    } catch (error) {
      toast.error(`Test failed: ${error instanceof Error ? error.message : "unknown error"}`)
    } finally {
      setTesting(false)
    }
  }

  const handleRun = async () => {
    if (prompt.trim().length === 0) return
    setRunning(true)
    setRunResult(null)
    try {
      const res = await fetch("/api/local-claude/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt }),
      })
      if (!res.ok) throw new Error(await res.text())
      const data: LocalClaudeRunResult = await res.json()
      setRunResult(data)
      if (!data.ok) toast.error("The agent run did not complete cleanly.")
    } catch (error) {
      toast.error(`Run failed: ${error instanceof Error ? error.message : "unknown error"}`)
    } finally {
      setRunning(false)
    }
  }

  const update = <K extends keyof LocalClaudeConfigInput>(
    key: K,
    value: LocalClaudeConfigInput[K],
  ) => setConfig((prev) => ({ ...prev, [key]: value }))

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm" className={cn("h-[34px]", className)}>
          Local Agent
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-[640px] max-h-[85vh] overflow-hidden flex flex-col">
        <DialogHeader>
          <DialogTitle>Local Claude Agent</DialogTitle>
        </DialogHeader>

        <Tabs defaultValue="setup" className="flex-1 overflow-hidden flex flex-col">
          <TabsList className="grid w-full grid-cols-3">
            <TabsTrigger value="setup">Setup</TabsTrigger>
            <TabsTrigger value="config">Configuration</TabsTrigger>
            <TabsTrigger value="test">Test &amp; Run</TabsTrigger>
          </TabsList>

          {/* ---------- SETUP (things you do outside this app) ---------- */}
          <TabsContent value="setup" className="flex-1 overflow-y-auto pr-1 text-sm">
            <div className="space-y-4">
              <p className="text-muted-foreground">
                This feature runs agents on <strong>your own machine</strong> using your local
                Claude Code install and its login. Your subscription powers the runs — this app
                never sees your credentials.
              </p>

              <div className="rounded-md border border-amber-300 bg-amber-50 p-3 text-amber-900">
                <strong>Requirement:</strong> the app server must run on the{" "}
                <em>same machine</em> as Claude Code. It cannot reach a CLI on a remote device.
                Run CompeteMath locally (<code>pnpm dev</code>) to use this.
              </div>

              <ol className="list-decimal space-y-3 pl-5">
                <li>
                  <strong>Install Claude Code.</strong>
                  <pre className="mt-1 overflow-x-auto rounded bg-muted p-2 text-xs">
                    npm install -g @anthropic-ai/claude-code
                  </pre>
                  Verify with <code>claude --version</code>.
                </li>
                <li>
                  <strong>Log in with your subscription.</strong> In a terminal run{" "}
                  <code>claude login</code> and choose your Pro/Max account. (Alternatively, an{" "}
                  <code>ANTHROPIC_API_KEY</code> in the server environment is used if present.)
                </li>
                <li>
                  <strong>Confirm the binary path.</strong> Run <code>which claude</code>. If it
                  isn&apos;t on the server&apos;s PATH, paste the full path into{" "}
                  <em>Configuration → Binary path</em>.
                </li>
                <li>
                  <strong>Run the setup test.</strong> Open the <em>Test &amp; Run</em> tab and
                  click <em>Test setup</em> — it checks the binary, version, and login for you.
                </li>
              </ol>

              <p className="text-muted-foreground">
                Everything below the binary/login step is configurable in the{" "}
                <em>Configuration</em> tab. The two things this app can&apos;t do for you are
                installing the CLI and logging it in — those happen once, in your terminal.
              </p>
            </div>
          </TabsContent>

          {/* ---------- CONFIGURATION (everything controllable in-UI) ---------- */}
          <TabsContent value="config" className="flex-1 overflow-y-auto pr-1">
            <div className="space-y-4 py-1">
              <div className="flex items-center justify-between rounded-md border p-3">
                <div>
                  <Label htmlFor="lca-enabled">Enable Local Claude Agent</Label>
                  <p className="text-xs text-muted-foreground">
                    When off, run requests are rejected.
                  </p>
                </div>
                <Switch
                  id="lca-enabled"
                  checked={config.enabled}
                  onCheckedChange={(v) => update("enabled", v)}
                />
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="lca-binary">Binary path</Label>
                <Input
                  id="lca-binary"
                  value={config.binaryPath}
                  placeholder="claude"
                  onChange={(e) => update("binaryPath", e.target.value)}
                />
                <p className="text-xs text-muted-foreground">
                  Command or absolute path to the Claude Code CLI (from{" "}
                  <code>which claude</code>).
                </p>
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="lca-cwd">Working directory</Label>
                <Input
                  id="lca-cwd"
                  value={config.workingDirectory ?? ""}
                  placeholder="/Users/you/projects/my-repo (defaults to server cwd)"
                  onChange={(e) => update("workingDirectory", e.target.value || null)}
                />
                <p className="text-xs text-muted-foreground">
                  The project directory the agent operates in.
                </p>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label htmlFor="lca-model">Model</Label>
                  <Input
                    id="lca-model"
                    value={config.model ?? ""}
                    placeholder="claude-opus-4-8 (optional)"
                    onChange={(e) => update("model", e.target.value || null)}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label>Permission mode</Label>
                  <Select
                    value={config.permissionMode}
                    onValueChange={(v) =>
                      update("permissionMode", v as LocalClaudePermissionMode)
                    }
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {PERMISSION_MODE_OPTIONS.map((o) => (
                        <SelectItem key={o.value} value={o.value}>
                          {o.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="lca-tools">Allowed tools</Label>
                <Input
                  id="lca-tools"
                  value={config.allowedTools ?? ""}
                  placeholder='e.g. "Read Edit Bash(git:*)" — blank = no restriction'
                  onChange={(e) => update("allowedTools", e.target.value || null)}
                />
                <p className="text-xs text-muted-foreground">
                  Passed to <code>--allowedTools</code>. Restricts what the agent may do.
                </p>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label htmlFor="lca-maxturns">Max turns</Label>
                  <Input
                    id="lca-maxturns"
                    type="number"
                    min={1}
                    value={config.maxTurns ?? ""}
                    placeholder="unlimited"
                    onChange={(e) =>
                      update("maxTurns", e.target.value ? Number(e.target.value) : null)
                    }
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="lca-timeout">Timeout (ms)</Label>
                  <Input
                    id="lca-timeout"
                    type="number"
                    min={5000}
                    step={1000}
                    value={config.timeoutMs}
                    onChange={(e) =>
                      update("timeoutMs", Number(e.target.value) || DEFAULT_LOCAL_CLAUDE_CONFIG.timeoutMs)
                    }
                  />
                </div>
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="lca-sysprompt">Append to system prompt</Label>
                <Textarea
                  id="lca-sysprompt"
                  rows={2}
                  value={config.systemPromptAppend ?? ""}
                  placeholder="Extra instructions added to every run (optional)"
                  onChange={(e) => update("systemPromptAppend", e.target.value || null)}
                />
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="lca-extra">Extra CLI args (advanced)</Label>
                <Input
                  id="lca-extra"
                  value={extraArgsText}
                  placeholder="--add-dir /tmp --verbose"
                  onChange={(e) => setExtraArgsText(e.target.value)}
                />
                <p className="text-xs text-muted-foreground">
                  Raw flags appended verbatim. Space-separated.
                </p>
              </div>

              <div className="flex justify-end gap-2 pt-1">
                <Button onClick={handleSave} disabled={saving || loading}>
                  {saving ? "Saving…" : "Save configuration"}
                </Button>
              </div>
            </div>
          </TabsContent>

          {/* ---------- TEST & RUN ---------- */}
          <TabsContent value="test" className="flex-1 overflow-y-auto pr-1">
            <div className="space-y-4 py-1">
              <div>
                <div className="flex items-center justify-between">
                  <div>
                    <p className="font-medium">Setup test</p>
                    <p className="text-xs text-muted-foreground">
                      Verifies the binary, version, and login using your current settings.
                    </p>
                  </div>
                  <Button onClick={handleTest} disabled={testing} variant="outline">
                    {testing ? "Testing…" : "Test setup"}
                  </Button>
                </div>

                {testResult && (
                  <div className="mt-3 space-y-2 rounded-md border p-3">
                    <CheckRow
                      label="Binary found"
                      ok={testResult.checks.binaryFound.ok}
                      detail={testResult.checks.binaryFound.detail}
                    />
                    <CheckRow
                      label="Version"
                      ok={testResult.checks.version.ok}
                      detail={testResult.checks.version.detail}
                    />
                    <CheckRow
                      label="Logged in"
                      ok={testResult.checks.authenticated.ok}
                      detail={testResult.checks.authenticated.detail}
                    />
                  </div>
                )}
              </div>

              <Separator />

              <div className="space-y-2">
                <Label htmlFor="lca-prompt">Try a prompt</Label>
                <Textarea
                  id="lca-prompt"
                  rows={3}
                  value={prompt}
                  placeholder="e.g. List the files in this project and summarize what it does."
                  onChange={(e) => setPrompt(e.target.value)}
                />
                <div className="flex justify-end">
                  <Button onClick={handleRun} disabled={running || prompt.trim().length === 0}>
                    {running ? "Running…" : "Run agent"}
                  </Button>
                </div>

                {runResult && (
                  <div className="mt-2 space-y-2 rounded-md border p-3">
                    <div className="flex items-center gap-2 text-xs">
                      <Badge variant={runResult.ok ? "default" : "destructive"}>
                        {runResult.ok ? "success" : runResult.timedOut ? "timed out" : "error"}
                      </Badge>
                      <span className="text-muted-foreground">
                        {runResult.durationMs} ms · exit {String(runResult.exitCode)}
                      </span>
                    </div>
                    {runResult.text && (
                      <pre className="max-h-48 overflow-auto whitespace-pre-wrap rounded bg-muted p-2 text-xs">
                        {runResult.text}
                      </pre>
                    )}
                    {!runResult.ok && runResult.stderr && (
                      <pre className="max-h-32 overflow-auto whitespace-pre-wrap rounded bg-red-50 p-2 text-xs text-red-900">
                        {runResult.stderr}
                      </pre>
                    )}
                  </div>
                )}
              </div>
            </div>
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  )
}

function CheckRow({ label, ok, detail }: { label: string; ok: boolean; detail: string }) {
  return (
    <div className="flex items-start gap-2 text-sm">
      <span className={cn("mt-0.5 font-bold", ok ? "text-green-600" : "text-red-600")}>
        {ok ? "✓" : "✗"}
      </span>
      <div>
        <span className="font-medium">{label}</span>
        {detail && <p className="text-xs text-muted-foreground break-words">{detail}</p>}
      </div>
    </div>
  )
}
