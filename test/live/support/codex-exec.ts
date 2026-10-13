/**
 * `codex exec resume <thread> <prompt> --json`: the headless resume path (scenario 5). Runs in the
 * temp CODEX_HOME with the cheap model, and lists the peers tools the JSONL event stream shows.
 */
import type { CodexLiveEnv, RunResult } from './codex-env'
import { LIVE_EFFORT, LIVE_MODEL } from './codex-thread'

export interface ExecResult extends RunResult {
  readonly events: readonly Record<string, unknown>[]
  /** `peers_*` tools called, in order. */
  readonly tools: readonly string[]
}

const parseLines = (text: string): readonly Record<string, unknown>[] =>
  text.split('\n').flatMap((line) => {
    try {
      const value: unknown = JSON.parse(line)
      return typeof value === 'object' && value !== null ? [value as Record<string, unknown>] : []
    } catch {
      return []
    }
  })

export async function execResume(
  live: CodexLiveEnv,
  threadId: string,
  cwd: string,
  prompt: string,
): Promise<ExecResult> {
  const result = await live.run(
    [
      live.codex,
      'exec',
      'resume',
      '--json',
      '-m',
      LIVE_MODEL,
      '-c',
      `model_reasoning_effort="${LIVE_EFFORT}"`,
      threadId,
      prompt,
    ],
    { cwd, timeoutMs: 240_000 },
  )
  const events = parseLines(result.stdout)
  const tools = [...result.stdout.matchAll(/"tool":"(peers_[a-z_]+)"/g)].map((m) => m[1] as string)
  return { ...result, events, tools: [...new Set(tools)] }
}
