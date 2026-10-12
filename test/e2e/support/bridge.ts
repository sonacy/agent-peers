/**
 * A real bridge process (`bun run packages/cli/src/bin.ts mcp --surface <s>`) driven over stdio by the
 * MCP SDK client, with the clientInfo, spawn environment and `_meta` the simulated agent would send.
 */
import { Client, StdioClientTransport } from './deps'
import type { Machine } from './machine'
import { BIN_PATH } from './paths'
import { profileFor, type Surface, type SurfaceProfile } from './profiles'

export interface ToolOutput {
  readonly text: string
  readonly structured: Readonly<Record<string, unknown>> | undefined
  readonly isError: boolean
}

export interface BridgeOptions {
  /** The agent's own session key: Claude Code session id, Codex thread id (ignored for Desktop). */
  readonly sessionKey?: string
  /** Extra spawn environment (e.g. Cursor markers). */
  readonly env?: Readonly<Record<string, string>>
  /** Override the clientInfo the simulated agent sends. */
  readonly clientInfo?: SurfaceProfile['clientInfo']
  /** Override the `--surface` argument. */
  readonly cliSurface?: string
}

export interface CallOptions {
  /** Codex: the thread the call comes from (default: the bridge's session key). */
  readonly thread?: string
  /** false: send no `_meta` (Codex `mcp_tool` hook calls carry their ids in the arguments). */
  readonly meta?: boolean
  readonly timeoutMs?: number
}

export interface Bridge {
  readonly surface: Surface
  readonly machine: Machine
  readonly sessionKey: string | undefined
  readonly pid: number
  readonly instructions: string | undefined
  toolNames(): Promise<readonly string[]>
  call(tool: string, args?: Readonly<Record<string, unknown>>, options?: CallOptions): Promise<ToolOutput>
  /** Like call, but fails the test when the tool reports an error. */
  ok(tool: string, args?: Readonly<Record<string, unknown>>, options?: CallOptions): Promise<ToolOutput>
  stderr(): string
  /** Closes stdin (the agent quit) and waits for the process to exit. */
  close(): Promise<void>
}

const DEFAULT_CALL_TIMEOUT_MS = 120_000

function textOf(content: unknown): string {
  if (!Array.isArray(content)) return ''
  return content
    .map((part) => (typeof part === 'object' && part !== null && 'text' in part ? String(part.text) : ''))
    .join('\n')
}

async function waitExit(pid: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0)
    } catch {
      return
    }
    await Bun.sleep(25)
  }
  process.kill(pid, 'SIGKILL')
}

export async function startBridge(
  machine: Machine,
  surface: Surface,
  options: BridgeOptions = {},
): Promise<Bridge> {
  const profile = profileFor(surface)
  const env = { ...machine.env, ...profile.env(machine, options.sessionKey), ...options.env }
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['run', BIN_PATH, 'mcp', '--surface', options.cliSurface ?? profile.cliSurface],
    env,
    cwd: machine.workspace,
    stderr: 'pipe',
  })
  let errText = ''
  transport.stderr?.on('data', (chunk: Buffer) => {
    errText += chunk.toString('utf8')
  })
  const client = new Client(options.clientInfo ?? profile.clientInfo, { capabilities: {} })
  await client.connect(transport)
  const pid = transport.pid ?? 0
  const call = async (tool: string, args: Readonly<Record<string, unknown>> = {}, opts: CallOptions = {}) => {
    const meta = opts.meta === false ? undefined : profile.meta(opts.thread ?? options.sessionKey)
    const result = await client.callTool(
      { name: tool, arguments: { ...args }, ...(meta ? { _meta: meta } : {}) },
      undefined,
      { timeout: opts.timeoutMs ?? DEFAULT_CALL_TIMEOUT_MS },
    )
    const structured = result.structuredContent as Readonly<Record<string, unknown>> | undefined
    return { text: textOf(result.content), structured, isError: result.isError === true }
  }
  let closed: Promise<void> | undefined
  return {
    surface,
    machine,
    sessionKey: options.sessionKey,
    pid,
    instructions: client.getInstructions(),
    toolNames: async () => (await client.listTools()).tools.map((tool) => tool.name),
    call,
    async ok(tool, args, opts) {
      const out = await call(tool, args, opts)
      if (out.isError)
        throw new Error(`${surface} ${tool} failed: ${out.text}\n--- bridge stderr ---\n${errText}`)
      return out
    },
    stderr: () => errText,
    close() {
      closed ??= client.close().then(() => waitExit(pid, 10_000))
      return closed
    },
  }
}
