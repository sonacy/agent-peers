/**
 * Runs a short-lived external command (the Codex CLI) with a hard timeout, via Bun.spawn. On timeout
 * the child gets SIGTERM, then SIGKILL after a grace period, and the pipes are read only briefly
 * after it exits (a grandchild may hold them open), so a run never hangs.
 */
import type { EnvLike } from '@agent-peers/core'

export interface ProcessResult {
  /** null when the process could not be started or was killed. */
  readonly exitCode: number | null
  readonly stdout: string
  readonly stderr: string
  readonly timedOut: boolean
}

export interface RunOptions {
  readonly env: EnvLike
  readonly timeoutMs: number
  /** Time between SIGTERM and SIGKILL after a timeout. */
  readonly killGraceMs?: number
}

export type ProcessRunner = (cmd: readonly string[], options: RunOptions) => Promise<ProcessResult>

/** Output kept for diagnostics; the CLI's answers are short. */
const MAX_OUTPUT_CHARS = 16 * 1024
export const KILL_GRACE_MS = 1000
/** After exit, pipes still held open by a grandchild are abandoned after this long. */
const PIPE_DRAIN_MS = 250

const definedEnv = (env: EnvLike): Record<string, string> =>
  Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined))

/** Reads a pipe to the end, or what arrived before `until` resolves. */
async function drain(stream: ReadableStream<Uint8Array>, until: Promise<void>): Promise<string> {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let text = ''
  const stop = until.then(() => 'stop' as const)
  try {
    for (;;) {
      const next = await Promise.race([reader.read(), stop])
      if (next === 'stop' || next.done) break
      if (text.length < MAX_OUTPUT_CHARS) text += decoder.decode(next.value, { stream: true })
    }
  } finally {
    reader.cancel().catch(() => undefined)
  }
  return text.slice(0, MAX_OUTPUT_CHARS)
}

export const bunRunner: ProcessRunner = async (cmd, options) => {
  let proc: ReturnType<typeof Bun.spawn<'ignore', 'pipe', 'pipe'>>
  try {
    proc = Bun.spawn([...cmd], {
      env: definedEnv(options.env),
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
    })
  } catch (error) {
    return { exitCode: null, stdout: '', stderr: `cannot start ${cmd[0]}: ${String(error)}`, timedOut: false }
  }
  let timedOut = false
  let killTimer: ReturnType<typeof setTimeout> | undefined
  const timer = setTimeout(() => {
    timedOut = true
    proc.kill('SIGTERM')
    killTimer = setTimeout(() => proc.kill('SIGKILL'), options.killGraceMs ?? KILL_GRACE_MS)
  }, options.timeoutMs)
  const exited = proc.exited.then(() => Bun.sleep(PIPE_DRAIN_MS))
  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      drain(proc.stdout, exited),
      drain(proc.stderr, exited),
      proc.exited,
    ])
    return { exitCode: timedOut ? null : exitCode, stdout, stderr, timedOut }
  } finally {
    clearTimeout(timer)
    if (killTimer !== undefined) clearTimeout(killTimer)
  }
}
