import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { runMcpCommand } from '../src/commands/mcp'
import { main } from '../src/program'
import { memoryIo, stdioRpc } from './helpers/world'

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'apc-mcp-'))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

const toolNames = (response: Record<string, unknown>): string[] =>
  ((response.result as { tools: { name: string }[] }).tools ?? []).map((t) => t.name)

describe('agent-peers mcp', () => {
  it('--selftest builds the bridge, reports and exits 0', async () => {
    const io = memoryIo({ AGENT_PEERS_HOME: dir })
    expect(
      await main(['mcp', '--surface', 'claude-code', '--selftest'], io, { mcp: { ownProcess: false } }),
    ).toBe(0)
    expect(io.err.join('')).toContain('agent-peers mcp selftest ok (claude-code)')
  })

  it('rejects an unknown surface and a missing one', async () => {
    const io = memoryIo({ AGENT_PEERS_HOME: dir })
    expect(await main(['mcp', '--surface', 'gemini'], io)).toBe(2)
    expect(io.err.join('')).toContain('--surface must be one of')
    const missing = memoryIo({})
    expect(await main(['mcp'], missing)).toBe(2)
    expect(missing.err.join('')).toContain("required option '--surface <surface>'")
  })

  it('serves MCP over stdio for Claude Desktop and stops when stdin ends', async () => {
    const stdin = new PassThrough()
    const stdout = new PassThrough()
    const rpc = stdioRpc(stdin, stdout)
    const io = memoryIo({ AGENT_PEERS_HOME: dir })
    const code = await main(['mcp', '--surface', 'claude-desktop'], io, {
      mcp: { stdio: { stdin, stdout }, ownProcess: false, userHome: dir, log: () => undefined },
    })
    expect(code).toBeUndefined()
    const init = await rpc.request('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'claude-ai', version: '0.1.0' },
    })
    expect((init.result as { serverInfo: { name: string } }).serverInfo.name).toBeTruthy()
    rpc.notify('notifications/initialized')
    expect(toolNames(await rpc.request('tools/list'))).toContain('peers_inbox')
    rpc.end()
  })

  it('plugs the Codex queue injector in for codex surfaces', async () => {
    const stdin = new PassThrough()
    const stdout = new PassThrough()
    const rpc = stdioRpc(stdin, stdout)
    const logs: string[] = []
    await runMcpCommand({ surface: 'codex' }, memoryIo({ AGENT_PEERS_HOME: dir }), {
      stdio: { stdin, stdout },
      ownProcess: false,
      userHome: dir,
      log: (line) => logs.push(line),
      injectorOptions: { resolve: async () => undefined, log: (line) => logs.push(line) },
    })
    await rpc.request('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'codex-mcp-client', title: 'Codex', version: '0.160.1' },
    })
    rpc.notify('notifications/initialized')
    expect(toolNames(await rpc.request('tools/list'))).toContain('peers_hook')
    expect(logs.join('\n')).toContain('codex queue unavailable: codex CLI not found')
    rpc.end()
  })
})
