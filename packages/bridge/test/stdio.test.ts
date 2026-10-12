import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { runMcp } from '../src/run'

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'apb-io-'))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

/** Reads newline-delimited JSON-RPC messages from the bridge's stdout. */
function reader(stream: PassThrough) {
  let buffer = ''
  let lines: string[] = []
  stream.on('data', (chunk: Buffer) => {
    buffer += chunk.toString('utf8')
    const parts = buffer.split('\n')
    buffer = parts.pop() ?? ''
    lines = [...lines, ...parts.filter((p) => p.trim().length > 0)]
  })
  return async (id: number): Promise<Record<string, unknown>> => {
    for (let i = 0; i < 200; i += 1) {
      const hit = lines.map((l) => JSON.parse(l) as Record<string, unknown>).find((m) => m.id === id)
      if (hit) return hit
      await Bun.sleep(5)
    }
    throw new Error(`no response ${id}`)
  }
}

describe('agent-peers mcp over stdio', () => {
  it('answers initialize and tools/list, and shuts down when stdin ends', async () => {
    const stdin = new PassThrough()
    const stdout = new PassThrough()
    const next = reader(stdout)
    const bridge = await runMcp({
      argv: ['--surface', 'codex'],
      home: dir,
      userHome: dir,
      env: {},
      stdio: { stdin, stdout },
      ownProcess: false,
      log: () => undefined,
    })
    const send = (message: Record<string, unknown>) =>
      stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`)
    send({
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'codex-mcp-client', title: 'Codex', version: '0.160.1' },
      },
    })
    const init = await next(1)
    const result = init.result as { instructions?: string; serverInfo?: { name?: string } }
    expect(result.serverInfo?.name).toBe('agent-peers')
    expect(result.instructions).toContain('peers_hook')
    send({ method: 'notifications/initialized' })
    send({ id: 2, method: 'tools/list', params: {} })
    const list = await next(2)
    expect((list.result as { tools: unknown[] }).tools).toHaveLength(16)
    stdin.end()
    await bridge?.whenClosed()
    expect(bridge?.verdict?.ok).toBe(true)
  })
})
