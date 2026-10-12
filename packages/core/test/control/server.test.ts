import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PeersError } from '@agent-peers/protocol'
import { callControl } from '../../src/control/client'
import type { ControlHandler } from '../../src/control/ops'
import { ControlServer } from '../../src/control/server'
import { aborted, fakeHandler, sleep } from '../helpers/control'
import { errorCode } from '../helpers/error-code'

let dir: string
let servers: ControlServer[] = []

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'pc-'))
})
afterEach(async () => {
  await Promise.all(servers.map((s) => s.close()))
  servers = []
  await rm(dir, { recursive: true, force: true })
})

async function start(handler: ControlHandler, extra: { requestTimeoutMs?: number; pid?: number } = {}) {
  const server = await ControlServer.start({
    runDir: join(dir, 'run'),
    handler,
    agentKind: 'claude-code',
    pid: extra.pid ?? 4242,
    ancestorPids: [4242, 77],
    localKeys: ['k1'],
    now: () => 99,
    ...(extra.requestTimeoutMs === undefined ? {} : { requestTimeoutMs: extra.requestTimeoutMs }),
  })
  servers.push(server)
  return server
}

/** Sends raw lines and collects reply lines until `count` arrive or the socket closes. */
async function raw(
  path: string,
  payload: string,
  count: number,
): Promise<{ lines: string[]; closed: boolean }> {
  const lines: string[] = []
  let buffer = ''
  let closed = false
  const encoder = new TextEncoder()
  let rest = new Uint8Array(0)
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, 2000)
    void Bun.connect({
      unix: path,
      socket: {
        open: (s) => {
          rest = encoder.encode(payload)
          rest = rest.subarray(s.write(rest))
        },
        drain: (s) => {
          rest = rest.subarray(s.write(rest))
        },
        data: (s, chunk) => {
          buffer += new TextDecoder().decode(chunk)
          const parts = buffer.split('\n')
          buffer = parts.pop() ?? ''
          lines.push(...parts.filter((p) => p.length > 0))
          if (lines.length >= count) {
            clearTimeout(timer)
            s.end()
            resolve()
          }
        },
        close: () => {
          closed = true
          clearTimeout(timer)
          resolve()
        },
      },
    })
  })
  return { lines, closed }
}

describe('ControlServer files', () => {
  it('binds a 0600 socket, writes the info file and removes both on close', async () => {
    const server = await start(fakeHandler())
    expect(server.socketPath).toBe(join(dir, 'run', '4242.sock'))
    expect((await stat(server.socketPath)).mode & 0o777).toBe(0o600)
    expect((await stat(join(dir, 'run'))).mode & 0o777).toBe(0o700)
    const info = JSON.parse(await readFile(server.infoPath, 'utf8'))
    expect(info).toEqual({
      pid: 4242,
      ancestor_pids: [4242, 77],
      agent_pid: 77,
      agent_kind: 'claude-code',
      local_keys: ['k1'],
      started_at: 99,
    })
    await server.setLocalKeys(['k1', 'k2', 'k2'])
    expect(server.advertisedKeys).toEqual(['k1', 'k2'])
    expect(JSON.parse(await readFile(server.infoPath, 'utf8')).local_keys).toEqual(['k1', 'k2'])
    await server.close()
    await server.close()
    expect(await errorCode(stat(server.socketPath))).toBe('non-peers')
    expect(await errorCode(stat(server.infoPath))).toBe('non-peers')
  })

  it('refuses socket paths that are too long', async () => {
    const long = join(dir, 'x'.repeat(120))
    const code = await errorCode(
      ControlServer.start({
        runDir: long,
        handler: fakeHandler(),
        agentKind: 'codex',
        pid: 1,
        ancestorPids: [],
      }),
    )
    expect(code).toBe('internal')
  })
})

describe('ControlServer requests', () => {
  it('serves every op through callControl', async () => {
    const server = await start(
      fakeHandler({
        take: async (p) => ({ envelope: `env ${p.max_chars}`, inject_id: 'i1' }),
        turn_end: async (p) => ({ reminder: `ids ${p.inject_ids.length}` }),
        gate: async (p) => ({ decision: 'deny', reason: p.tool }),
        permission: async () => ({ allow: true }),
        autojoin: async (p) => ({ accepted: p.agent_kind === 'claude-code' }),
      }),
    )
    const path = server.socketPath
    expect(await callControl(path, 'register', { local_key: 'k1', source: 'startup', cwd: '/w' })).toEqual({
      context: 'hello',
    })
    expect(await callControl(path, 'activity', { local_key: 'k1', state: 'busy' })).toEqual({})
    expect(await callControl(path, 'take', { local_key: 'k1', max_chars: 8000 })).toEqual({
      envelope: 'env 8000',
      inject_id: 'i1',
    })
    expect(await callControl(path, 'turn_end', { local_key: 'k1' })).toEqual({ reminder: 'ids 0' })
    expect(await callControl(path, 'end', { local_key: 'k1' })).toEqual({})
    expect(await callControl(path, 'gate', { local_key: 'k1', tool: 'Bash', input: {} })).toEqual({
      decision: 'deny',
      reason: 'Bash',
    })
    expect(await callControl(path, 'permission', { local_key: 'k1', tool: 'peers_reply' })).toEqual({
      allow: true,
    })
    expect(
      await callControl(path, 'autojoin', { local_key: 'k', agent_kind: 'claude-code', workspace: '/w' }),
    ).toEqual({ accepted: true })
  })

  it('maps handler errors and invalid results', async () => {
    const server = await start(
      fakeHandler({
        activity: async () => {
          throw new PeersError('forbidden', 'nope')
        },
        end: async () => {
          throw new Error('secret internals')
        },
        gate: async () => ({ decision: 'maybe' }) as never,
      }),
    )
    expect(
      await errorCode(callControl(server.socketPath, 'activity', { local_key: 'k', state: 'idle' })),
    ).toBe('forbidden')
    await expect(callControl(server.socketPath, 'end', { local_key: 'k' })).rejects.toThrow('internal error')
    expect(
      await errorCode(callControl(server.socketPath, 'gate', { local_key: 'k', tool: 'x', input: 1 })),
    ).toBe('internal')
    expect(
      await errorCode(callControl(server.socketPath, 'take', { local_key: 'k', max_chars: 1 } as never)),
    ).toBe('invalid_params')
  })

  it('survives garbage lines and answers the next request on the same connection', async () => {
    const server = await start(fakeHandler())
    const payload = [
      'not json',
      '[1,2]',
      '{"jsonrpc":"2.0","id":5,"result":{}}',
      '{"jsonrpc":"2.0","id":6,"method":"bogus","params":{}}',
      '',
      '{"jsonrpc":"2.0","id":7,"method":"end","params":{"local_key":"k"}}',
    ].join('\n')
    const { lines } = await raw(server.socketPath, `${payload}\n`, 5)
    const replies = lines.map((l) => JSON.parse(l))
    expect(replies.map((r) => r.error?.data?.code ?? 'ok')).toEqual([
      'parse_error',
      'invalid_request',
      'invalid_request',
      'method_not_found',
      'ok',
    ])
    expect(replies[4]).toEqual({ jsonrpc: '2.0', id: 7, result: {} })
  })

  it('rejects an overlong line and closes the connection', async () => {
    const server = await start(fakeHandler())
    const { lines, closed } = await raw(server.socketPath, 'x'.repeat(1024 * 1024 + 10), 1)
    expect(JSON.parse(lines[0] ?? '{}').error.data.code).toBe('payload_too_large')
    await sleep(20)
    expect(closed).toBe(true)
  })

  it('times out slow non-wait requests', async () => {
    const server = await start(
      fakeHandler({
        activity: (_p, ctx) => aborted(ctx.signal).then(() => ({})),
      }),
      { requestTimeoutMs: 30 },
    )
    await expect(
      callControl(server.socketPath, 'activity', { local_key: 'k', state: 'idle' }),
    ).rejects.toThrow(/timed out after 30 ms/)
  })

  it('reports a re-queue when the client is gone before take answers', async () => {
    const handler = fakeHandler({
      take: async () => {
        await sleep(40)
        return { envelope: 'e', inject_id: 'late' }
      },
    })
    const server = await start(handler)
    expect(
      await errorCode(
        callControl(server.socketPath, 'take', { local_key: 'k9', max_chars: 1000 }, { timeoutMs: 5 }),
      ),
    ).toBe('timeout')
    await sleep(80)
    expect(handler.undeliveredLog).toEqual([
      { localKey: 'k9', injected: { envelope: 'e', inject_id: 'late' } },
    ])
  })
})

describe('delivered', () => {
  it('reports envelopes written back for take and wait', async () => {
    const log: string[] = []
    const handler = fakeHandler({
      take: async () => ({ envelope: 'e', inject_id: 't1' }),
      wait: async () => ({ envelope: 'w', inject_id: 'w1' }),
      delivered: (key, op, injected) => {
        log.push(`${key}:${op}:${injected.inject_id}`)
      },
    })
    const server = await start(handler)
    await callControl(server.socketPath, 'take', { local_key: 'k', max_chars: 1000 })
    await callControl(server.socketPath, 'wait', { local_key: 'k', timeout_ms: 1000 })
    await sleep(10)
    expect(log).toEqual(['k:take:t1', 'k:wait:w1'])
  })
})

describe('wait', () => {
  it('returns null on timeout', async () => {
    const server = await start(fakeHandler())
    expect(await callControl(server.socketPath, 'wait', { local_key: 'k', timeout_ms: 20 })).toBeNull()
  })

  it('returns an envelope when one arrives', async () => {
    const server = await start(
      fakeHandler({
        wait: async () => {
          await sleep(10)
          return { envelope: 'woke', inject_id: 'w1' }
        },
      }),
    )
    expect(await callControl(server.socketPath, 'wait', { local_key: 'k', timeout_ms: 1000 })).toEqual({
      envelope: 'woke',
      inject_id: 'w1',
    })
  })

  it('keeps one waiter per local_key: a newer wait makes the older return null', async () => {
    let calls = 0
    const handler = fakeHandler({
      wait: async (p, ctx) => {
        if (p.local_key === 'other') {
          await aborted(ctx.signal)
          return null
        }
        calls++
        if (calls === 1) {
          await aborted(ctx.signal)
          await sleep(5)
          return { envelope: 'too late', inject_id: 'old' }
        }
        await sleep(30)
        return { envelope: 'fresh', inject_id: 'new' }
      },
    })
    const server = await start(handler)
    const first = callControl(server.socketPath, 'wait', { local_key: 'k', timeout_ms: 5000 })
    await sleep(20)
    const other = callControl(server.socketPath, 'wait', { local_key: 'other', timeout_ms: 30 })
    const second = callControl(server.socketPath, 'wait', { local_key: 'k', timeout_ms: 5000 })
    expect(await first).toBeNull()
    expect(await second).toEqual({ envelope: 'fresh', inject_id: 'new' })
    expect(await other).toBeNull()
    await sleep(20)
    expect(handler.undeliveredLog.map((u) => u.injected.inject_id)).toEqual(['old'])
  })

  it('aborts pending waits when the server closes', async () => {
    const server = await start(fakeHandler())
    const pending = errorCode(callControl(server.socketPath, 'wait', { local_key: 'k', timeout_ms: 5000 }))
    await sleep(20)
    await server.close()
    expect(await pending).toBe('disconnected')
  })
})
