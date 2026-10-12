/**
 * CLI test world: a real hub (':memory:', port 0), a remote peer driven by the core client, and a
 * Claude Code bridge started through `agent-peers mcp` over in-memory stdio, with its control
 * socket in a temp AGENT_PEERS_HOME. Nothing touches the real home or a real agent.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { HubClient, LocalHome, SessionHandle } from '@agent-peers/core'
import { createHub, type Hub, silentLogger } from '@agent-peers/hub'
import { runMcpCommand } from '../../src/commands/mcp'
import type { CliIo } from '../../src/io'

export interface Rpc {
  request(method: string, params?: Record<string, unknown>): Promise<Record<string, unknown>>
  notify(method: string, params?: Record<string, unknown>): void
  end(): void
}

/** Newline-delimited JSON-RPC over the bridge's stdio streams. */
export function stdioRpc(stdin: PassThrough, stdout: PassThrough): Rpc {
  let buffer = ''
  let messages: Record<string, unknown>[] = []
  stdout.on('data', (chunk: Buffer) => {
    buffer += chunk.toString('utf8')
    const parts = buffer.split('\n')
    buffer = parts.pop() ?? ''
    messages = [
      ...messages,
      ...parts.filter((p) => p.trim()).map((p) => JSON.parse(p) as Record<string, unknown>),
    ]
  })
  let id = 0
  const write = (message: Record<string, unknown>) =>
    stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`)
  return {
    async request(method, params = {}) {
      id += 1
      const mine = id
      write({ id: mine, method, params })
      for (let i = 0; i < 600; i += 1) {
        const hit = messages.find((m) => m.id === mine)
        if (hit) return hit
        await Bun.sleep(5)
      }
      throw new Error(`no response to ${method}`)
    },
    notify: (method, params = {}) => write({ method, params }),
    end: () => stdin.end(),
  }
}

export function memoryIo(env: Record<string, string>, stdin = ''): CliIo & { out: string[]; err: string[] } {
  const out: string[] = []
  const err: string[] = []
  return {
    env,
    out,
    err,
    readStdin: async () => stdin,
    stdout: (text) => out.push(text),
    stderr: (text) => err.push(text),
  }
}

export interface CliWorld {
  readonly dir: string
  readonly home: string
  readonly env: Record<string, string>
  readonly roomId: string
  readonly alice: SessionHandle
  readonly rpc: Rpc
  stop(): Promise<void>
}

const CLAUDE_CLIENT = { name: 'claude-code', version: '2.1.296' }

/** Hub + peer @home in room "team" + a Claude Code bridge (session cc-1) joined as @work. */
export async function startCliWorld(): Promise<CliWorld> {
  const dir = await mkdtemp(join(tmpdir(), 'apc-'))
  const hub: Hub = createHub({ publicBind: '127.0.0.1', publicPort: 0, adminPort: 0, logger: silentLogger })
  const info = await hub.start()
  const url = `http://127.0.0.1:${info.publicPort}`
  const client = new HubClient({
    bridge: { agent_kind: 'claude-code', agent_version: '2.1.0', adapter: '0.1.0', host: 'alice-laptop' },
    heartbeatMs: 60_000,
  })
  const alice = new SessionHandle(client, {
    localKey: 'alice-conv',
    card: { agent: { kind: 'claude-code', adapter: '0.1.0' }, host: 'alice-laptop' },
  })
  await client.connect(url, hub.services.members.create('alice').token)
  await alice.open()
  const created = await client.request('room.create', {
    session_id: alice.sessionId,
    name: 'team',
    handle: 'home',
  })
  await alice.join({ room_id: created.room.room_id })
  const home = join(dir, 'home')
  await new LocalHome({ root: home, userHome: dir }).setCredential(url, {
    member_token: hub.services.members.create('carol').token,
  })
  const env = { AGENT_PEERS_HOME: home, CLAUDE_CODE_SESSION_ID: 'cc-1', CLAUDECODE: '1' }
  const stdin = new PassThrough()
  const stdout = new PassThrough()
  const rpc = stdioRpc(stdin, stdout)
  await runMcpCommand({ surface: 'claude-code' }, memoryIo(env), {
    stdio: { stdin, stdout },
    ownProcess: false,
    userHome: dir,
    cwd: dir,
    log: () => undefined,
  })
  await rpc.request('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: CLAUDE_CLIENT,
  })
  rpc.notify('notifications/initialized')
  const code = created.invite_url.split('/').at(-1) ?? ''
  const joined = await rpc.request('tools/call', {
    name: 'peers_join',
    arguments: { invite: code, handle: 'work', remember: 'none' },
  })
  if ((joined.result as { isError?: boolean } | undefined)?.isError) throw new Error(JSON.stringify(joined))
  return {
    dir,
    home,
    env,
    roomId: created.room.room_id,
    alice,
    rpc,
    async stop() {
      rpc.end()
      await Bun.sleep(50)
      await client.close()
      alice.dispose()
      await hub.stop()
      await rm(dir, { recursive: true, force: true })
    },
  }
}
