import "server-only"

import { spawn } from "node:child_process"
import type {
  LocalClaudeConfigInput,
  LocalClaudeRunResult,
  LocalClaudeTestResult,
} from "@/lib/types/local-claude"

/**
 * Local Claude Agent runner.
 *
 * This module shells out to the user's locally-installed Claude Code CLI
 * (`claude`) in headless/print mode. Because it spawns a process on the host,
 * it ONLY works when this Next.js server is running on the same machine as the
 * user's Claude Code install (i.e. self-hosted / `pnpm dev` on their laptop).
 * It cannot reach a CLI on a remote user's device from a hosted deployment.
 *
 * Auth is inherited from the local install: whatever `claude` is logged in with
 * (a Pro/Max subscription via `claude login`, or an API key in the env) is what
 * these runs consume. This app never sees or stores those credentials.
 */

interface SpawnResult {
  stdout: string
  stderr: string
  exitCode: number | null
  timedOut: boolean
}

// Cap output so a runaway agent can't exhaust server memory.
const MAX_OUTPUT_BYTES = 5 * 1024 * 1024 // 5 MB

function runProcess(
  binary: string,
  args: string[],
  opts: { cwd?: string | null; timeoutMs: number; input?: string },
): Promise<SpawnResult> {
  return new Promise((resolve, reject) => {
    let child: ReturnType<typeof spawn>
    try {
      // Array args + no shell => arguments are passed literally, never
      // re-parsed by a shell, so prompt content can't inject flags/commands.
      child = spawn(binary, args, {
        cwd: opts.cwd || process.cwd(),
        env: process.env,
        shell: false,
      })
    } catch (error) {
      reject(error)
      return
    }

    let stdout = ""
    let stderr = ""
    let stdoutBytes = 0
    let timedOut = false

    const timer = setTimeout(() => {
      timedOut = true
      child.kill("SIGKILL")
    }, opts.timeoutMs)

    // Guard against the binary not existing / not being executable.
    child.on("error", (error) => {
      clearTimeout(timer)
      reject(error)
    })

    child.stdout?.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.length
      if (stdoutBytes <= MAX_OUTPUT_BYTES) stdout += chunk.toString("utf8")
    })
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8")
    })

    child.on("close", (code) => {
      clearTimeout(timer)
      resolve({ stdout, stderr, exitCode: code, timedOut })
    })

    if (opts.input !== undefined && child.stdin) {
      child.stdin.write(opts.input)
      child.stdin.end()
    }
  })
}

// Translate the stored config into concrete CLI flags for a headless run.
export function buildRunArgs(
  config: LocalClaudeConfigInput,
  prompt: string,
): string[] {
  const args: string[] = ["-p", prompt, "--output-format", "json"]

  if (config.model) args.push("--model", config.model)
  if (config.permissionMode) args.push("--permission-mode", config.permissionMode)
  if (config.allowedTools?.trim()) args.push("--allowedTools", config.allowedTools.trim())
  if (config.maxTurns != null) args.push("--max-turns", String(config.maxTurns))
  if (config.systemPromptAppend?.trim())
    args.push("--append-system-prompt", config.systemPromptAppend.trim())

  // Advanced escape hatch: raw flags the UI doesn't model.
  for (const extra of config.extraArgs || []) {
    if (typeof extra === "string" && extra.length > 0) args.push(extra)
  }

  return args
}

// Extract the final assistant text from `--output-format json`, falling back to
// raw stdout if the CLI didn't emit parseable JSON (older versions, errors).
function extractResultText(stdout: string): string {
  const trimmed = stdout.trim()
  if (!trimmed) return ""
  try {
    const parsed = JSON.parse(trimmed)
    if (typeof parsed?.result === "string") return parsed.result
    if (typeof parsed?.text === "string") return parsed.text
    return trimmed
  } catch {
    return trimmed
  }
}

export async function runLocalClaude(
  config: LocalClaudeConfigInput,
  prompt: string,
): Promise<LocalClaudeRunResult> {
  const start = Date.now()
  const args = buildRunArgs(config, prompt)

  let result: SpawnResult
  try {
    result = await runProcess(config.binaryPath, args, {
      cwd: config.workingDirectory,
      timeoutMs: config.timeoutMs,
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return {
      ok: false,
      text: "",
      exitCode: null,
      durationMs: Date.now() - start,
      timedOut: false,
      stderr: `Failed to launch "${config.binaryPath}": ${message}`,
    }
  }

  return {
    ok: result.exitCode === 0 && !result.timedOut,
    text: extractResultText(result.stdout),
    exitCode: result.exitCode,
    durationMs: Date.now() - start,
    timedOut: result.timedOut,
    stderr: result.stderr.slice(0, 4000),
  }
}

// Layered setup check: (1) binary resolves, (2) it reports a version,
// (3) a tiny prompt round-trips (proves it's authenticated and a model works).
export async function testLocalClaude(
  config: LocalClaudeConfigInput,
): Promise<LocalClaudeTestResult> {
  const checks: LocalClaudeTestResult["checks"] = {
    binaryFound: { ok: false, detail: "" },
    version: { ok: false, detail: "" },
    authenticated: { ok: false, detail: "" },
  }

  // 1 + 2: resolve the binary and read its version.
  try {
    const versionRun = await runProcess(config.binaryPath, ["--version"], {
      cwd: config.workingDirectory,
      timeoutMs: Math.min(config.timeoutMs, 15000),
    })
    checks.binaryFound = { ok: true, detail: `Found "${config.binaryPath}"` }
    if (versionRun.exitCode === 0) {
      checks.version = { ok: true, detail: versionRun.stdout.trim() || "version reported" }
    } else {
      checks.version = {
        ok: false,
        detail: versionRun.stderr.trim() || `exited with code ${versionRun.exitCode}`,
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const notFound = /ENOENT/.test(message)
    checks.binaryFound = {
      ok: false,
      detail: notFound
        ? `"${config.binaryPath}" not found on PATH. Install Claude Code or set the full path.`
        : message,
    }
    return { ok: false, checks }
  }

  if (!checks.version.ok) return { ok: false, checks }

  // 3: a minimal prompt confirms auth + model availability end to end.
  const probeArgs = ["-p", "Reply with exactly: OK", "--output-format", "json"]
  if (config.model) probeArgs.push("--model", config.model)

  const probe = await runProcess(config.binaryPath, probeArgs, {
    cwd: config.workingDirectory,
    timeoutMs: Math.min(config.timeoutMs, 60000),
  })

  const combined = `${probe.stdout}\n${probe.stderr}`.toLowerCase()
  if (probe.exitCode === 0 && extractResultText(probe.stdout)) {
    checks.authenticated = { ok: true, detail: "Claude responded to a test prompt." }
  } else if (probe.timedOut) {
    checks.authenticated = { ok: false, detail: "Test prompt timed out." }
  } else if (/log ?in|unauthor|authenticat|not logged|api key|credit/.test(combined)) {
    checks.authenticated = {
      ok: false,
      detail: "Claude Code is installed but not logged in. Run `claude login` in a terminal.",
    }
  } else {
    checks.authenticated = {
      ok: false,
      detail: probe.stderr.trim() || `Probe exited with code ${probe.exitCode}`,
    }
  }

  const ok = checks.binaryFound.ok && checks.version.ok && checks.authenticated.ok
  return {
    ok,
    checks,
    probe: { stdout: probe.stdout.slice(0, 4000), stderr: probe.stderr.slice(0, 4000), exitCode: probe.exitCode },
  }
}
