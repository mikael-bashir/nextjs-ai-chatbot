"use client"

import { useCallback, useEffect, useState } from "react"
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
  DEFAULT_LOCAL_CLAUDE_CONNECTION,
  type BridgeHealth,
  type LocalClaudeConfigInput,
  type LocalClaudeConnection,
  type LocalClaudePermissionMode,
  type LocalClaudeRunResult,
} from "@/lib/types/local-claude"

interface LocalClaudeAgentManagementProps {
  className?: string
}

const CONNECTION_STORAGE_KEY = "lca.connection"

const PERMISSION_MODE_OPTIONS: { value: LocalClaudePermissionMode; label: string }[] = [
  { value: "default", label: "default — prompt on sensitive actions" },
  { value: "acceptEdits", label: "acceptEdits — auto-accept file edits" },
  { value: "plan", label: "plan — read-only planning, no changes" },
  { value: "bypassPermissions", label: "bypassPermissions — allow everything" },
]

interface CheckState {
  ok: boolean
  detail: string
}

// A failed fetch to http://localhost from an HTTPS page is opaque (TypeError),
// so give the user the three likely causes rather than a bare "failed".
function bridgeUnreachableMessage(bridgeUrl: string): string {
  return `Couldn't reach the bridge at ${bridgeUrl}. Check that: (1) the bridge is running (the command in the Configuration tab), (2) the URL/port match, and (3) you're on Chrome, Edge, or Firefox — Safari blocks calls from HTTPS pages to http://localhost.`
}

// Generate a URL-safe token in the browser. Setup needs no copy-back because
// the app injects this same value into the run command shown to the user.
function generateToken(): string {
  const bytes = new Uint8Array(24)
  crypto.getRandomValues(bytes)
  let binary = ""
  for (const b of bytes) binary += String.fromCharCode(b)
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

// Read run preferences (non-secret) and turn them into the bridge's run options.
function toRunOptions(config: LocalClaudeConfigInput) {
  return {
    model: config.model,
    permissionMode: config.permissionMode,
    allowedTools: config.allowedTools,
    maxTurns: config.maxTurns,
    timeoutMs: config.timeoutMs,
    systemPromptAppend: config.systemPromptAppend,
    workingDirectory: config.workingDirectory,
  }
}

export function LocalClaudeAgentManagement({ className }: LocalClaudeAgentManagementProps) {
  const [open, setOpen] = useState(false)

  // Non-secret preferences (server-persisted).
  const [config, setConfig] = useState<LocalClaudeConfigInput>(DEFAULT_LOCAL_CLAUDE_CONFIG)
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)

  // Connection to the local bridge (browser-only, never sent to the server).
  const [connection, setConnection] = useState<LocalClaudeConnection>(
    DEFAULT_LOCAL_CLAUDE_CONNECTION,
  )
  const [origin, setOrigin] = useState("")
  const [copied, setCopied] = useState(false)

  const [testing, setTesting] = useState(false)
  const [checks, setChecks] = useState<{
    reachable: CheckState
    version: CheckState
    authenticated: CheckState
  } | null>(null)

  const [prompt, setPrompt] = useState("")
  const [running, setRunning] = useState(false)
  const [runResult, setRunResult] = useState<LocalClaudeRunResult | null>(null)

  // The app origin is baked into the setup command (download URL + allowed origin).
  useEffect(() => {
    if (typeof window !== "undefined") setOrigin(window.location.origin)
  }, [])

  // Load server prefs + localStorage connection when the dialog opens.
  useEffect(() => {
    if (!open) return

    try {
      const raw = localStorage.getItem(CONNECTION_STORAGE_KEY)
      const loaded: LocalClaudeConnection = raw
        ? { ...DEFAULT_LOCAL_CLAUDE_CONNECTION, ...JSON.parse(raw) }
        : { ...DEFAULT_LOCAL_CLAUDE_CONNECTION }
      // Auto-generate a token on first use so the command is ready to copy.
      if (!loaded.token) loaded.token = generateToken()
      setConnection(loaded)
      localStorage.setItem(CONNECTION_STORAGE_KEY, JSON.stringify(loaded))
    } catch {
      /* ignore malformed localStorage */
    }

    setLoading(true)
    fetch("/api/local-claude/config")
      .then((res) => {
        if (!res.ok) throw new Error("Failed to load config")
        return res.json()
      })
      .then((data) => {
        setConfig({
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
        })
      })
      .catch(() => toast.error("Could not load your Local Agent preferences."))
      .finally(() => setLoading(false))
  }, [open])

  const update = <K extends keyof LocalClaudeConfigInput>(
    key: K,
    value: LocalClaudeConfigInput[K],
  ) => setConfig((prev) => ({ ...prev, [key]: value }))

  const persistConnection = (next: LocalClaudeConnection) => {
    setConnection(next)
    try {
      localStorage.setItem(CONNECTION_STORAGE_KEY, JSON.stringify(next))
    } catch {
      /* ignore quota/availability errors */
    }
  }

  // One-line command: downloads the bridge from this app and starts it with the
  // token already matched to this browser (no copy-back) and this origin allowed.
  const setupCommand =
    origin && connection.token
      ? `curl -fsSL '${origin}/local-claude-bridge.mjs' -o claude-bridge.mjs && BRIDGE_TOKEN='${connection.token}' ALLOWED_ORIGINS='${origin}' node claude-bridge.mjs`
      : ""

  const copyCommand = async () => {
    if (!setupCommand) return
    try {
      await navigator.clipboard.writeText(setupCommand)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      toast.error("Copy failed — select the command and copy it manually.")
    }
  }

  // Fetch against the bridge with the token header. Normalizes the opaque
  // cross-origin failure into a helpful message.
  const callBridge = useCallback(
    async (path: string, init?: RequestInit) => {
      const base = connection.bridgeUrl.replace(/\/$/, "")
      try {
        return await fetch(`${base}${path}`, {
          ...init,
          headers: {
            "content-type": "application/json",
            "x-bridge-token": connection.token,
            ...(init?.headers || {}),
          },
        })
      } catch {
        throw new Error(bridgeUnreachableMessage(connection.bridgeUrl))
      }
    },
    [connection],
  )

  const handleSavePrefs = async () => {
    setSaving(true)
    try {
      const res = await fetch("/api/local-claude/config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(config),
      })
      if (!res.ok) throw new Error(await res.text())
      toast.success("Preferences saved.")
    } catch (error) {
      toast.error(`Save failed: ${error instanceof Error ? error.message : "unknown error"}`)
    } finally {
      setSaving(false)
    }
  }

  const handleTest = async () => {
    if (!connection.token) {
      toast.error("Enter the bridge token first (printed when you run the bridge).")
      return
    }
    setTesting(true)
    setChecks(null)
    const next = {
      reachable: { ok: false, detail: "" },
      version: { ok: false, detail: "" },
      authenticated: { ok: false, detail: "" },
    }
    try {
      // 1 + 2: reachability and version via /health.
      const healthRes = await callBridge("/health", { method: "GET" })
      if (healthRes.status === 401) {
        next.reachable = { ok: true, detail: "Bridge reachable." }
        next.version = { ok: false, detail: "Token rejected by the bridge." }
        setChecks(next)
        toast.error("The bridge rejected the token.")
        return
      }
      const health: BridgeHealth = await healthRes.json()
      next.reachable = { ok: true, detail: "Bridge reachable." }
      next.version = health.ok
        ? { ok: true, detail: health.version || "version reported" }
        : { ok: false, detail: health.error || "claude --version failed" }

      if (!health.ok) {
        setChecks(next)
        return
      }

      // 3: a tiny prompt confirms the CLI is logged in.
      const runRes = await callBridge("/run", {
        method: "POST",
        body: JSON.stringify({
          prompt: "Reply with exactly: OK",
          options: { model: config.model, timeoutMs: 60000 },
        }),
      })
      const run: LocalClaudeRunResult = await runRes.json()
      if (run.ok && run.text) {
        next.authenticated = { ok: true, detail: "Claude responded to a test prompt." }
      } else if (run.timedOut) {
        next.authenticated = { ok: false, detail: "Test prompt timed out." }
      } else if (/log ?in|unauthor|authenticat|not logged|api key/i.test(run.stderr)) {
        next.authenticated = {
          ok: false,
          detail: "Claude Code isn't logged in. Run `claude login` in a terminal.",
        }
      } else {
        next.authenticated = { ok: false, detail: run.stderr || "Test prompt failed." }
      }
      setChecks(next)
      if (next.authenticated.ok) toast.success("Local agent is connected and ready.")
    } catch (error) {
      next.reachable = { ok: false, detail: error instanceof Error ? error.message : "unreachable" }
      setChecks(next)
      toast.error("Could not reach the bridge — see details below.")
    } finally {
      setTesting(false)
    }
  }

  const handleRun = async () => {
    if (prompt.trim().length === 0) return
    if (!config.enabled) {
      toast.error("Local Agent is disabled in Preferences.")
      return
    }
    setRunning(true)
    setRunResult(null)
    try {
      const res = await callBridge("/run", {
        method: "POST",
        body: JSON.stringify({ prompt, options: toRunOptions(config) }),
      })
      if (res.status === 401) throw new Error("The bridge rejected the token.")
      const data: LocalClaudeRunResult = await res.json()
      setRunResult(data)
      if (!data.ok) toast.error("The agent run did not complete cleanly.")
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Run failed.")
    } finally {
      setRunning(false)
    }
  }

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

          {/* ---------- SETUP ---------- */}
          <TabsContent value="setup" className="flex-1 overflow-y-auto pr-1 text-sm">
            <div className="space-y-4">
              <p className="text-muted-foreground">
                This runs agents on <strong>your machine</strong> using your logged-in Claude
                Code. Your browser talks to a small <strong>bridge</strong> you run locally —
                prompts and results never touch our servers, and your own subscription powers the
                runs.
              </p>

              <ol className="list-decimal space-y-3 pl-5">
                <li>
                  <strong>Install &amp; log in to Claude Code</strong> (once, in a terminal):
                  <pre className="mt-1 overflow-x-auto rounded bg-muted p-2 text-xs">
                    npm install -g @anthropic-ai/claude-code{"\n"}claude login
                  </pre>
                </li>
                <li>
                  <strong>Start the bridge.</strong> Open the <em>Configuration</em> tab, copy the
                  one-line command, and run it in a terminal. It downloads the bridge and starts it
                  with a token already linked to this browser — nothing to paste back. Keep the
                  terminal open while you use this.
                </li>
                <li>
                  <strong>Test.</strong> Open <em>Test &amp; Run → Test connection</em>.
                </li>
              </ol>

              <div className="rounded-md border border-amber-300 bg-amber-50 p-3 text-amber-900">
                <strong>Browser note:</strong> use <strong>Chrome, Edge, or Firefox</strong>.
                Safari blocks HTTPS pages from calling <code>http://localhost</code>, so this
                feature won&apos;t work there.
              </div>
            </div>
          </TabsContent>

          {/* ---------- CONFIGURATION ---------- */}
          <TabsContent value="config" className="flex-1 overflow-y-auto pr-1">
            <div className="space-y-5 py-1">
              {/* Connection — browser-only */}
              <div className="space-y-3">
                <div>
                  <h3 className="text-sm font-semibold">Connection</h3>
                  <p className="text-xs text-muted-foreground">
                    Stored in this browser only — never sent to our servers.
                  </p>
                </div>

                {/* One-command setup */}
                <div className="space-y-1.5">
                  <Label>1. Run this on your machine</Label>
                  <div className="relative">
                    <pre className="overflow-x-auto whitespace-pre-wrap break-all rounded bg-muted p-2 pr-16 text-xs">
                      {setupCommand || "Loading…"}
                    </pre>
                    <Button
                      type="button"
                      size="sm"
                      variant="secondary"
                      className="absolute right-1.5 top-1.5 h-6 px-2 text-xs"
                      onClick={copyCommand}
                      disabled={!setupCommand}
                    >
                      {copied ? "Copied" : "Copy"}
                    </Button>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    Requires Claude Code installed and logged in (<code>claude login</code>). This
                    downloads the bridge and starts it with a token already matched to this browser
                    — nothing to copy back. Keep that terminal open.
                  </p>
                </div>

                {/* Advanced / manual overrides */}
                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-1.5">
                    <Label htmlFor="lca-url">Bridge URL</Label>
                    <Input
                      id="lca-url"
                      value={connection.bridgeUrl}
                      placeholder="http://localhost:4123"
                      onChange={(e) => persistConnection({ ...connection, bridgeUrl: e.target.value })}
                    />
                  </div>
                  <div className="space-y-1.5">
                    <div className="flex items-center justify-between">
                      <Label htmlFor="lca-token">Bridge token</Label>
                      <button
                        type="button"
                        className="text-xs text-muted-foreground underline"
                        onClick={() => persistConnection({ ...connection, token: generateToken() })}
                      >
                        Regenerate
                      </button>
                    </div>
                    <Input
                      id="lca-token"
                      type="password"
                      value={connection.token}
                      placeholder="auto-generated"
                      onChange={(e) => persistConnection({ ...connection, token: e.target.value })}
                    />
                  </div>
                </div>
                <p className="text-xs text-muted-foreground">
                  Regenerating the token means re-running the command above with the new value.
                </p>
              </div>

              <Separator />

              {/* Preferences — server-synced */}
              <div className="space-y-4">
                <div>
                  <h3 className="text-sm font-semibold">Run preferences</h3>
                  <p className="text-xs text-muted-foreground">
                    Non-secret settings, synced to your account and sent to the bridge per run.
                  </p>
                </div>

                <div className="flex items-center justify-between rounded-md border p-3">
                  <div>
                    <Label htmlFor="lca-enabled">Enable Local Agent</Label>
                    <p className="text-xs text-muted-foreground">When off, runs are blocked.</p>
                  </div>
                  <Switch
                    id="lca-enabled"
                    checked={config.enabled}
                    onCheckedChange={(v) => update("enabled", v)}
                  />
                </div>

                <div className="space-y-1.5">
                  <Label htmlFor="lca-cwd">Working directory</Label>
                  <Input
                    id="lca-cwd"
                    value={config.workingDirectory ?? ""}
                    placeholder="/Users/you/projects/my-repo (defaults to the bridge's cwd)"
                    onChange={(e) => update("workingDirectory", e.target.value || null)}
                  />
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
                      onValueChange={(v) => update("permissionMode", v as LocalClaudePermissionMode)}
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
                        update(
                          "timeoutMs",
                          Number(e.target.value) || DEFAULT_LOCAL_CLAUDE_CONFIG.timeoutMs,
                        )
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

                <div className="flex justify-end">
                  <Button onClick={handleSavePrefs} disabled={saving || loading}>
                    {saving ? "Saving…" : "Save preferences"}
                  </Button>
                </div>
              </div>
            </div>
          </TabsContent>

          {/* ---------- TEST & RUN ---------- */}
          <TabsContent value="test" className="flex-1 overflow-y-auto pr-1">
            <div className="space-y-4 py-1">
              <div>
                <div className="flex items-center justify-between">
                  <div>
                    <p className="font-medium">Connection test</p>
                    <p className="text-xs text-muted-foreground">
                      Checks the bridge, the CLI version, and that Claude is logged in.
                    </p>
                  </div>
                  <Button onClick={handleTest} disabled={testing} variant="outline">
                    {testing ? "Testing…" : "Test connection"}
                  </Button>
                </div>

                {checks && (
                  <div className="mt-3 space-y-2 rounded-md border p-3">
                    <CheckRow label="Bridge reachable" {...checks.reachable} />
                    <CheckRow label="CLI version" {...checks.version} />
                    <CheckRow label="Logged in" {...checks.authenticated} />
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
