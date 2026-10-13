/**
 * Runs the real Claude Code CLI for live tests: `-p` with stream-json output (so tool calls and tool
 * results are visible), a cheap model, the plugin loaded session-scoped with `--plugin-dir`, user
 * settings skipped (no user hooks or plugins) and only the peers MCP tools pre-allowed. Never
 * `--dangerously-skip-permissions`.
 */
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { LiveMachine } from './machine'
import { PLUGIN_DIR } from './machine'

export const PEERS_TOOLS_PATTERN = 'mcp__plugin_peers_peers__*'
export const LIVE_MODEL = process.env.AGENT_PEERS_LIVE_MODEL ?? 'haiku'
/** Hard cap per invocation (USD), passed as --max-budget-usd. */
const BUDGET_USD = process.env.AGENT_PEERS_LIVE_BUDGET ?? '0.40'

/** The real claude binary: never a wrapper shim on PATH that injects its own hooks (cmux). */
export function claudeBinary(): string {
  const explicit = process.env.AGENT_PEERS_CLAUDE_BIN
  if (explicit) return explicit
  const local = join(homedir(), '.local/bin/claude')
  if (existsSync(local)) return local
  const found = Bun.which('claude')
  if (!found) throw new Error('claude not found: set AGENT_PEERS_CLAUDE_BIN')
  return found
}

/** The parent environment minus anything tying the child to the Claude session running the tests. */
export function claudeEnv(machine: LiveMachine): Record<string, string> {
  const base = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] =>
        entry[1] !== undefined && !/^(CLAUDE|CMUX|AGENT_PEERS_)/.test(entry[0]),
    ),
  )
  return { ...base, ...machine.env, ENABLE_CLAUDEAI_MCP_SERVERS: 'false', DISABLE_AUTOUPDATER: '1' }
}

export interface ClaudeOptions {
  readonly prompt?: string
  readonly resume?: string
  readonly sessionId?: string
  /** Tools allowed without a prompt besides the peers tools. */
  readonly allow?: readonly string[]
  readonly streamingInput?: boolean
  readonly extra?: readonly string[]
}

export function claudeArgs(options: ClaudeOptions): string[] {
  return [
    claudeBinary(),
    '-p',
    '--model',
    LIVE_MODEL,
    '--plugin-dir',
    PLUGIN_DIR,
    '--setting-sources',
    'project,local',
    '--allowedTools',
    [PEERS_TOOLS_PATTERN, ...(options.allow ?? [])].join(','),
    '--output-format',
    'stream-json',
    '--verbose',
    '--include-hook-events',
    '--max-budget-usd',
    BUDGET_USD,
    ...(options.streamingInput ? ['--input-format', 'stream-json'] : []),
    ...(options.resume ? ['--resume', options.resume] : []),
    ...(options.sessionId ? ['--session-id', options.sessionId] : []),
    ...(options.extra ?? []),
    ...(options.prompt === undefined ? [] : [options.prompt]),
  ]
}

export type StreamEvent = Readonly<Record<string, unknown>> & { readonly type?: string }

export interface ToolCallView {
  readonly id: string
  readonly name: string
  readonly input: unknown
  /** The raw tool_result content. */
  readonly result?: string
  /** The human text: `structuredContent.text` when Claude Code passed structured content. */
  readonly text?: string
  readonly isError?: boolean
}

/** The bridge repeats its text in structuredContent.text, which is what Claude Code shows the model. */
function humanText(raw: string): string {
  try {
    const parsed = JSON.parse(raw) as { text?: unknown }
    return typeof parsed?.text === 'string' ? parsed.text : raw
  } catch {
    return raw
  }
}

function blocks(event: StreamEvent): readonly Record<string, unknown>[] {
  const message = event.message as { content?: unknown } | undefined
  return Array.isArray(message?.content) ? (message.content as Record<string, unknown>[]) : []
}

function resultText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return JSON.stringify(content ?? '')
  return content
    .map((c: { type?: string; text?: string }) => (c.type === 'text' ? (c.text ?? '') : JSON.stringify(c)))
    .join('\n')
}

/** Tool calls in order, each with its result once it came back. */
export function toolCalls(events: readonly StreamEvent[]): readonly ToolCallView[] {
  const uses = events
    .filter((e) => e.type === 'assistant')
    .flatMap(blocks)
    .filter((b) => b.type === 'tool_use')
  const results = new Map(
    events
      .filter((e) => e.type === 'user')
      .flatMap(blocks)
      .filter((b) => b.type === 'tool_result')
      .map((b) => [b.tool_use_id as string, b] as const),
  )
  return uses.map((u) => {
    const r = results.get(u.id as string)
    return {
      id: u.id as string,
      name: u.name as string,
      input: u.input,
      ...(r
        ? {
            result: resultText(r.content),
            text: humanText(resultText(r.content)),
            isError: r.is_error === true,
          }
        : {}),
    }
  })
}

/** Assistant text, all turns. */
export const assistantText = (events: readonly StreamEvent[]): string =>
  events
    .filter((e) => e.type === 'assistant')
    .flatMap(blocks)
    .filter((b) => b.type === 'text')
    .map((b) => b.text as string)
    .join('\n')

export const sessionIdOf = (events: readonly StreamEvent[]): string | undefined =>
  events.find((e) => e.type === 'system' && e.subtype === 'init')?.session_id as string | undefined

export const costOf = (events: readonly StreamEvent[]): number =>
  events
    .filter((e) => e.type === 'result')
    .reduce((sum, e) => sum + (typeof e.total_cost_usd === 'number' ? e.total_cost_usd : 0), 0)

function parseLines(text: string): StreamEvent[] {
  return text
    .split('\n')
    .filter((line) => line.trim().startsWith('{'))
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as StreamEvent]
      } catch {
        return []
      }
    })
}

export interface ClaudeRun {
  readonly exitCode: number | null
  readonly events: readonly StreamEvent[]
  readonly stderr: string
  readonly sessionId: string | undefined
  readonly calls: readonly ToolCallView[]
  readonly text: string
  readonly cost: number
}

const summarize = (events: StreamEvent[], exitCode: number | null, stderr: string): ClaudeRun => ({
  exitCode,
  events,
  stderr,
  sessionId: sessionIdOf(events),
  calls: toolCalls(events),
  text: assistantText(events),
  cost: costOf(events),
})

/** One `claude -p` run to completion (killed after `timeoutMs`). */
export async function runClaude(
  machine: LiveMachine,
  options: ClaudeOptions,
  timeoutMs = 180_000,
): Promise<ClaudeRun> {
  const proc = Bun.spawn(claudeArgs(options), {
    cwd: machine.workspace,
    env: claudeEnv(machine),
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const timer = setTimeout(() => proc.kill('SIGTERM'), timeoutMs)
  try {
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ])
    const exitCode = await proc.exited
    await Bun.write(join(machine.logs, `claude-${Date.now()}.jsonl`), stdout)
    return summarize(parseLines(stdout), exitCode, stderr)
  } finally {
    clearTimeout(timer)
  }
}

/**
 * `claude -p --input-format stream-json`: stdin stays open, so the process (and its bridge and
 * asyncRewake waiters) outlives each turn. User turns are sent as stream-json user messages.
 */
export class StreamingClaude {
  private buffer = ''
  private all: StreamEvent[] = []
  private errText = ''
  private constructor(
    private readonly proc: Bun.Subprocess<'pipe', 'pipe', 'pipe'>,
    private readonly machine: LiveMachine,
  ) {
    void this.pump()
    void new Response(proc.stderr).text().then((t) => {
      this.errText = t
    })
  }

  static start(machine: LiveMachine, options: ClaudeOptions = {}): StreamingClaude {
    const proc = Bun.spawn(claudeArgs({ ...options, streamingInput: true }), {
      cwd: machine.workspace,
      env: claudeEnv(machine),
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
    })
    return new StreamingClaude(proc, machine)
  }

  get events(): readonly StreamEvent[] {
    return this.all
  }

  get stderr(): string {
    return this.errText
  }

  get exited(): Promise<number> {
    return this.proc.exited
  }

  send(text: string): void {
    const line = JSON.stringify({ type: 'user', message: { role: 'user', content: text } })
    this.proc.stdin.write(`${line}\n`)
    this.proc.stdin.flush()
  }

  /** Index of the next event, to wait only for later ones. */
  mark(): number {
    return this.all.length
  }

  /** Number of finished turns (`result` events) at or after `after`. */
  results(after = 0): readonly StreamEvent[] {
    return this.all.slice(after).filter((e) => e.type === 'result')
  }

  async close(): Promise<number | null> {
    try {
      this.proc.stdin.end()
    } catch {
      // already closed
    }
    const timer = setTimeout(() => this.proc.kill('SIGTERM'), 15_000)
    const code = await this.proc.exited
    clearTimeout(timer)
    await Bun.write(
      join(this.machine.logs, `claude-stream-${Date.now()}.jsonl`),
      this.all.map((e) => JSON.stringify(e)).join('\n'),
    )
    return code
  }

  kill(): void {
    this.proc.kill('SIGKILL')
  }

  private async pump(): Promise<void> {
    const decoder = new TextDecoder()
    const reader = this.proc.stdout.getReader()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      this.buffer += decoder.decode(value, { stream: true })
      const lines = this.buffer.split('\n')
      this.buffer = lines.pop() ?? ''
      this.all = [...this.all, ...parseLines(lines.join('\n'))]
    }
  }
}
