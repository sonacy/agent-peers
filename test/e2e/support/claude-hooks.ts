/**
 * Real Claude Code hook invocations: `bun run packages/cli/src/bin.ts hook <event> --agent claude-code`
 * with the hook JSON on stdin (shaped like test/fixtures/hooks/claude-code), spawned by the test
 * process, the same parent as the bridge, so control-socket discovery by ancestor PID works as it
 * does under a real Claude Code process.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Machine } from './machine'
import { BIN_PATH, HOOK_FIXTURES } from './paths'

export type ClaudeEvent =
  | 'SessionStart'
  | 'UserPromptSubmit'
  | 'Stop'
  | 'StopFailure'
  | 'Notification'
  | 'PermissionRequest'
  | 'PreToolUse'
  | 'SessionEnd'

export interface HookRun {
  readonly exitCode: number
  readonly stdout: string
  readonly stderr: string
}

/** The kebab-case event argument the plugin's hooks.json passes. */
const ARG: Readonly<Record<ClaudeEvent, string>> = {
  SessionStart: 'session-start',
  UserPromptSubmit: 'user-prompt-submit',
  Stop: 'stop',
  StopFailure: 'stop-failure',
  Notification: 'notification',
  PermissionRequest: 'permission-request',
  PreToolUse: 'pre-tool-use',
  SessionEnd: 'session-end',
}

export type HookPayload = Readonly<Record<string, unknown>>

/** A fixture payload for `event`, rewritten for this machine's session and workspace. */
export function claudePayload(
  machine: Machine,
  event: ClaudeEvent,
  sessionId: string,
  extra: HookPayload = {},
): HookPayload {
  const fixture = JSON.parse(readFileSync(join(HOOK_FIXTURES, `${event}.json`), 'utf8')) as HookPayload
  return {
    ...fixture,
    session_id: sessionId,
    cwd: machine.workspace,
    transcript_path: join(machine.dir, '.claude', 'projects', `${sessionId}.jsonl`),
    ...extra,
  }
}

function spawnHook(machine: Machine, args: readonly string[], payload: HookPayload, env: HookPayload = {}) {
  return Bun.spawn([process.execPath, 'run', BIN_PATH, 'hook', ...args, '--agent', 'claude-code'], {
    cwd: machine.workspace,
    env: { ...machine.env, CLAUDECODE: '1', CLAUDE_PROJECT_DIR: machine.workspace, ...env } as Record<
      string,
      string
    >,
    stdin: new Blob([JSON.stringify(payload)]),
    stdout: 'pipe',
    stderr: 'pipe',
  })
}

async function collect(proc: ReturnType<typeof spawnHook>): Promise<HookRun> {
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return { exitCode, stdout, stderr }
}

/** Runs one synchronous hook and returns what Claude Code would read. */
export function runClaudeHook(
  machine: Machine,
  event: ClaudeEvent,
  payload: HookPayload,
  env: HookPayload = {},
): Promise<HookRun> {
  return collect(spawnHook(machine, [ARG[event]], payload, env))
}

export interface Waiter {
  readonly result: Promise<HookRun>
  readonly done: () => boolean
  kill(): void
}

/** The asyncRewake waiter (`hook wait`), armed with the payload of the hook that armed it. */
export function startWaiter(machine: Machine, payload: HookPayload, timeoutSeconds = 600): Waiter {
  const proc = spawnHook(machine, ['wait', '--timeout', String(timeoutSeconds)], payload)
  let finished = false
  const result = collect(proc).finally(() => {
    finished = true
  })
  return {
    result,
    done: () => finished,
    kill: () => {
      if (!finished) proc.kill('SIGKILL')
    },
  }
}

/** Parses hook stdout (`{}` when empty). */
export function hookJson(run: HookRun): Readonly<Record<string, unknown>> {
  const text = run.stdout.trim()
  return text === '' ? {} : (JSON.parse(text) as Record<string, unknown>)
}
