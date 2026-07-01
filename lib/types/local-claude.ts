export type LocalClaudePermissionMode =
  | "default"
  | "acceptEdits"
  | "plan"
  | "bypassPermissions"

// The subset of config a user can edit from the UI.
export interface LocalClaudeConfigInput {
  binaryPath: string
  workingDirectory: string | null
  model: string | null
  permissionMode: LocalClaudePermissionMode
  allowedTools: string | null
  maxTurns: number | null
  timeoutMs: number
  systemPromptAppend: string | null
  extraArgs: string[]
  enabled: boolean
}

export interface LocalClaudeConfig extends LocalClaudeConfigInput {
  id: string
  userId: string
  createdAt: string
  updatedAt: string
}

// Sensible defaults used when a user has never saved a config.
export const DEFAULT_LOCAL_CLAUDE_CONFIG: LocalClaudeConfigInput = {
  binaryPath: "claude",
  workingDirectory: null,
  model: null,
  permissionMode: "default",
  allowedTools: null,
  maxTurns: null,
  timeoutMs: 120000,
  systemPromptAppend: null,
  extraArgs: [],
  enabled: true,
}

// Result of the "Test setup" button. Each check is independent so the UI can
// show the user exactly which step failed.
export interface LocalClaudeTestResult {
  ok: boolean
  checks: {
    binaryFound: { ok: boolean; detail: string }
    version: { ok: boolean; detail: string }
    authenticated: { ok: boolean; detail: string }
  }
  // Raw probe output (stdout/stderr), useful for troubleshooting.
  probe?: { stdout: string; stderr: string; exitCode: number | null }
}

export interface LocalClaudeRunResult {
  ok: boolean
  text: string
  exitCode: number | null
  durationMs: number
  timedOut: boolean
  stderr: string
}
