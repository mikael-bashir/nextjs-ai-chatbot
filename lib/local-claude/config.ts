import {
  DEFAULT_LOCAL_CLAUDE_CONFIG,
  type LocalClaudeConfigInput,
  type LocalClaudePermissionMode,
} from "@/lib/types/local-claude"

const PERMISSION_MODES: LocalClaudePermissionMode[] = [
  "default",
  "acceptEdits",
  "plan",
  "bypassPermissions",
]

function emptyToNull(value: unknown): string | null {
  if (typeof value !== "string") return null
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

// Coerce arbitrary untrusted input (request body, or a DB row) into a valid,
// fully-populated config. Never throws — falls back to defaults per field.
export function normalizeLocalClaudeConfigInput(
  raw: Record<string, unknown> | null | undefined,
): LocalClaudeConfigInput {
  const r = raw ?? {}

  const binaryPath =
    typeof r.binaryPath === "string" && r.binaryPath.trim().length > 0
      ? r.binaryPath.trim()
      : DEFAULT_LOCAL_CLAUDE_CONFIG.binaryPath

  const permissionMode = PERMISSION_MODES.includes(
    r.permissionMode as LocalClaudePermissionMode,
  )
    ? (r.permissionMode as LocalClaudePermissionMode)
    : "default"

  let maxTurns: number | null = null
  if (typeof r.maxTurns === "number" && Number.isFinite(r.maxTurns) && r.maxTurns > 0) {
    maxTurns = Math.floor(r.maxTurns)
  }

  let timeoutMs = DEFAULT_LOCAL_CLAUDE_CONFIG.timeoutMs
  if (typeof r.timeoutMs === "number" && Number.isFinite(r.timeoutMs)) {
    // Clamp to a sane range: 5s min, 30min max.
    timeoutMs = Math.min(Math.max(Math.floor(r.timeoutMs), 5000), 1800000)
  }

  let extraArgs: string[] = []
  if (Array.isArray(r.extraArgs)) {
    extraArgs = r.extraArgs.filter((a): a is string => typeof a === "string" && a.length > 0)
  }

  return {
    binaryPath,
    workingDirectory: emptyToNull(r.workingDirectory),
    model: emptyToNull(r.model),
    permissionMode,
    allowedTools: emptyToNull(r.allowedTools),
    maxTurns,
    timeoutMs,
    systemPromptAppend: emptyToNull(r.systemPromptAppend),
    extraArgs,
    enabled: r.enabled !== false,
  }
}
