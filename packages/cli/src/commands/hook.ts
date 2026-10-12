/**
 * `agent-peers hook <event> --agent <agent> [--wait] [--timeout <s>]` (ARCHITECTURE §2, §5): the
 * entrypoint of the plugin's lifecycle hooks. Claude Code hooks talk to the bridge over the control
 * socket; Codex hooks use `mcp_tool` handlers that call `peers_hook` directly, so a command hook for
 * another agent is a no-op. Whatever happens, a hook exits 0 with valid JSON (or 2 to wake).
 */
import {
  type ClaudeHookDeps,
  DEFAULT_WAIT_TIMEOUT_S,
  defaultClaudeHookDeps,
  fileLogger,
  hookLogPath,
  runClaudeHook,
} from '@agent-peers/bridge'
import { peersPaths, resolvePeersHome } from '@agent-peers/core'
import { toPeersError } from '@agent-peers/protocol'
import { Command, InvalidArgumentError } from 'commander'
import type { CliIo } from '../io'

export interface HookCommandOptions {
  readonly agent: string
  readonly wait?: boolean
  readonly timeout?: number
}

/** Seams for tests: hook dependencies and the waiter's tuning. */
export interface HookCommandDeps {
  readonly claude?: (io: CliIo) => ClaudeHookDeps
  readonly waiter?: {
    readonly reconnectWindowMs?: number
    readonly retryMs?: number
    readonly budgetMs?: number
  }
}

const EMPTY_HOOK_OUTPUT = '{}\n'

function parseSeconds(value: string): number {
  const seconds = Number(value)
  if (!Number.isFinite(seconds) || seconds <= 0 || seconds > 7 * 24 * 3600)
    throw new InvalidArgumentError('expected a number of seconds')
  return seconds
}

/** Logs to the hook log; never throws (the hook must still answer). */
async function logWarning(io: CliIo, line: string): Promise<void> {
  const root = resolvePeersHome(io.env)
  await fileLogger(hookLogPath(peersPaths(root).root), (text) => io.stderr(`${text}\n`))(line)
}

export async function runHookCommand(
  event: string,
  options: HookCommandOptions,
  io: CliIo,
  deps: HookCommandDeps = {},
): Promise<number> {
  try {
    if (options.agent !== 'claude-code') {
      await logWarning(io, `hook ${event}: agent ${options.agent} does not use command hooks, ignored`)
      io.stdout(EMPTY_HOOK_OUTPUT)
      return 0
    }
    const stdin = await io.readStdin()
    const claude =
      deps.claude?.(io) ?? defaultClaudeHookDeps(io.env, { stderr: (line) => io.stderr(`${line}\n`) })
    const result = await runClaudeHook(
      {
        event,
        stdin,
        env: io.env,
        ...(options.wait === undefined ? {} : { wait: options.wait }),
        ...(options.timeout === undefined ? {} : { timeoutSeconds: options.timeout }),
        ...(deps.waiter === undefined ? {} : { waiter: deps.waiter }),
      },
      claude,
    )
    if (result.stdout) io.stdout(result.stdout)
    if (result.stderr) io.stderr(result.stderr)
    return result.exitCode
  } catch (error) {
    await logWarning(io, `hook ${event}: ${toPeersError(error).message}`)
    io.stdout(EMPTY_HOOK_OUTPUT)
    return 0
  }
}

export function hookCommand(io: CliIo, setExit: (code: number) => void, deps: HookCommandDeps = {}): Command {
  return new Command('hook')
    .description('run an agent lifecycle hook (reads the hook JSON from stdin)')
    .argument(
      '<event>',
      'hook event: session-start, user-prompt-submit, stop, stop-failure, notification, permission-request, pre-tool-use, session-end or wait',
    )
    .option('--agent <agent>', 'the agent running the hook', 'claude-code')
    .option('--wait', 'run as the asyncRewake waiter (wake the session when a peer message arrives)')
    .option(
      '--timeout <seconds>',
      `the hook's configured timeout, so the waiter exits before it (default ${DEFAULT_WAIT_TIMEOUT_S})`,
      parseSeconds,
    )
    .action(async (event: string, options: HookCommandOptions) => {
      setExit(await runHookCommand(event, options, io, deps))
    })
}
