import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { broadcastToBridges, callBridge } from '../../src/control/client'
import { Dispatcher } from '../../src/control/dispatch'
import { LineReader, LineWriter } from '../../src/control/lines'
import {
  agentAncestor,
  ancestorChain,
  isSharedAncestor,
  isShim,
  parsePsLine,
  pidIsAlive,
  psProcessTree,
} from '../../src/control/process-tree'
import {
  bridgeAgent,
  bridgeAncestors,
  discoverBridges,
  listBridges,
  readBridgeInfo,
  writeBridgeInfo,
} from '../../src/control/registry'
import { ControlServer } from '../../src/control/server'
import { fakeHandler, fakeTree } from '../helpers/control'
import { errorCode } from '../helpers/error-code'

let run: string

beforeEach(async () => {
  run = join(await mkdtemp(join(tmpdir(), 'pd-')), 'run')
  await mkdir(run, { recursive: true })
})
afterEach(async () => {
  await rm(join(run, '..'), { recursive: true, force: true })
})

const info = (pid: number, ancestor_pids: number[], local_keys: string[] = [], agent_pid?: number) =>
  writeBridgeInfo(run, {
    pid,
    ancestor_pids,
    agent_kind: 'codex',
    local_keys,
    started_at: 1,
    ...(agent_pid === undefined ? {} : { agent_pid }),
  })

describe('process tree', () => {
  it('walks ancestors nearest first and stops at PID 1 or launchd', async () => {
    const tree = fakeTree({ 900: 50, 50: 10, 10: 1, 1: 0, 800: 5, 5: { ppid: 1, comm: '/sbin/launchd' } })
    expect(await ancestorChain(tree, 900)).toEqual([900, 50, 10])
    expect(await ancestorChain(tree, 900, { includeSelf: false })).toEqual([50, 10])
    expect(await ancestorChain(tree, 800)).toEqual([800])
    expect(await ancestorChain(fakeTree({ 3: 4, 4: 3 }), 3)).toEqual([3, 4])
    expect(await bridgeAncestors(tree, 50)).toEqual([50, 10])
  })

  it('parses ps output and probes liveness', async () => {
    expect(parsePsLine('  123 /usr/bin/zsh\n')).toEqual({ ppid: 123, comm: '/usr/bin/zsh' })
    expect(parsePsLine('  7\n')).toEqual({ ppid: 7 })
    expect(parsePsLine('garbage')).toBeUndefined()
    expect(isSharedAncestor(1)).toBe(true)
    expect(isSharedAncestor(9, 'launchd')).toBe(true)
    expect(isSharedAncestor(9, 'node')).toBe(false)
    expect(pidIsAlive(process.pid)).toBe(true)
    expect(pidIsAlive(0)).toBe(false)
    expect(pidIsAlive(2 ** 22 + 12345)).toBe(false)
  })

  it('reads the real parent with ps (read-only)', async () => {
    const entry = await psProcessTree.lookup(process.pid)
    expect(entry?.ppid).toBe(process.ppid)
    expect(await psProcessTree.lookup(-1)).toBeUndefined()
    expect(await psProcessTree.lookup(2 ** 22 + 12345)).toBeUndefined()
    expect((await ancestorChain(psProcessTree, process.pid))[0]).toBe(process.pid)
  })
})

describe('registry and discovery', () => {
  // hook 999 → 50 (agent) → 10 → 1; hook 998 → 60 → 10
  const tree = fakeTree({ 999: 50, 998: 60, 997: 1, 50: 10, 60: 10, 10: 1, 100: 50, 200: 60, 300: 50 })

  it('reads info files and ignores malformed or mismatched ones', async () => {
    await info(100, [100, 50, 10], ['k1'])
    expect((await readBridgeInfo(run, 100))?.socket).toBe(join(run, '100.sock'))
    await writeFile(join(run, '101.json'), '{bad')
    await writeFile(
      join(run, '102.json'),
      JSON.stringify({ pid: 5, ancestor_pids: [], agent_kind: 'x', local_keys: [], started_at: 0 }),
    )
    expect(await readBridgeInfo(run, 101)).toBeUndefined()
    expect(await readBridgeInfo(run, 102)).toBeUndefined()
    expect(await readBridgeInfo(run, 103)).toBeUndefined()
  })

  it('removes files of dead bridges', async () => {
    await info(100, [100, 50])
    await info(400, [400, 50])
    await writeFile(join(run, '400.sock'), '')
    await writeFile(join(run, '401.sock'), '')
    const live = await listBridges(run, tree)
    expect(live.map((b) => b.pid)).toEqual([100])
    expect((await readdir(run)).sort()).toEqual(['100.json'])
  })

  it('picks bridges sharing the nearest ancestor, owner of the local key first', async () => {
    await info(100, [100, 50, 10], ['k1'])
    await info(200, [200, 60, 10])
    await info(300, [300, 50, 10], ['k2'])
    const ids = async (pid: number, localKey?: string) =>
      (await discoverBridges({ runDir: run, pid, tree, ...(localKey ? { localKey } : {}) })).map((b) => b.pid)
    expect(await ids(999)).toEqual([100, 300])
    expect(await ids(999, 'k2')).toEqual([300, 100])
    expect(await ids(998)).toEqual([200])
    expect(await ids(997)).toEqual([])
    expect(await discoverBridges({ runDir: join(run, 'none'), pid: 999, tree })).toEqual([])
  })
})

describe('agent-bound discovery', () => {
  // terminal 10 → zsh 20 → claude A 30 → bridge 31 / hooks 32 (via sh 33)
  //            → zsh 40 → claude B 50 → (npx node 51 →) bridge 52
  const tree = fakeTree({
    10: { ppid: 1, comm: '/Applications/iTerm2' },
    20: { ppid: 10, comm: '-zsh' },
    30: { ppid: 20, comm: 'claude' },
    31: { ppid: 30, comm: '/Users/u/.agent-peers/bin/current' },
    33: { ppid: 30, comm: '/bin/sh' },
    32: { ppid: 33, comm: 'agent-peers' },
    40: { ppid: 10, comm: '-zsh' },
    50: { ppid: 40, comm: 'claude' },
    51: { ppid: 50, comm: 'node' },
    52: { ppid: 51, comm: 'agent-peers' },
    60: { ppid: 20, comm: 'node', args: 'node /usr/lib/node_modules/@anthropic-ai/claude-code/cli.js' },
    61: { ppid: 60, comm: 'node', args: 'node /usr/lib/node_modules/npm/bin/npx-cli.js agent-peers mcp' },
    62: { ppid: 61, comm: 'agent-peers' },
    70: { ppid: 20, comm: 'bun' },
  })

  it('finds the agent process past launchers', async () => {
    expect(await bridgeAgent(tree, 31)).toBe(30)
    expect(await bridgeAgent(tree, 52)).toBe(50)
    // A node-based agent is the agent; npx under it is a launcher; a bare runtime is a launcher.
    expect(await bridgeAgent(tree, 62)).toBe(60)
    expect(await bridgeAgent(tree, 70)).toBe(10)
    expect(await agentAncestor(fakeTree({ 5: { ppid: 1, comm: 'sh' } }), 5)).toBeUndefined()
    expect(await agentAncestor(fakeTree({ 5: 6, 6: 5 }), 5)).toBe(6)
    expect(await agentAncestor(fakeTree({ 5: { ppid: 6, comm: 'sh' }, 6: { ppid: 5, comm: 'sh' } }), 5)).toBe(
      undefined,
    )
    expect(isShim('-zsh')).toBe(true)
    expect(isShim('/usr/local/bin/claude')).toBe(false)
    expect(isShim('node', 'node /x/claude-code/cli.js')).toBe(false)
    expect(isShim('node', 'npm exec agent-peers')).toBe(true)
    expect(isShim('bun')).toBe(true)
  })

  it("never falls through to another session's bridge through a shared terminal", async () => {
    // Only B's bridge is up: A's hook must find nothing (it retries), not B's bridge.
    await info(52, [52, 51, 50, 40, 10], ['session-b'], 50)
    expect(await discoverBridges({ runDir: run, pid: 32, tree, localKey: 'session-a' })).toEqual([])
    await info(31, [31, 30, 20, 10], [], 30)
    expect((await discoverBridges({ runDir: run, pid: 32, tree })).map((b) => b.pid)).toEqual([31])
  })

  it('keeps matching legacy bridge files by shared ancestors', async () => {
    await info(31, [31, 30, 20, 10])
    expect((await discoverBridges({ runDir: run, pid: 32, tree })).map((b) => b.pid)).toEqual([31])
  })

  it('writes agent_pid from the server options', async () => {
    const server = await ControlServer.start({
      runDir: run,
      handler: fakeHandler(),
      agentKind: 'claude-code',
      pid: 31,
      tree,
    })
    try {
      expect((await readBridgeInfo(run, 31))?.agent_pid).toBe(30)
    } finally {
      await server.close()
    }
    const explicit = await ControlServer.start({
      runDir: run,
      handler: fakeHandler(),
      agentKind: 'claude-code',
      pid: 52,
      ancestorPids: [52, 1],
    })
    try {
      expect((await readBridgeInfo(run, 52))?.agent_pid).toBeUndefined()
    } finally {
      await explicit.close()
    }
  })
})

describe('callBridge / broadcast', () => {
  it('routes to the matching bridge and skips unreachable ones', async () => {
    const tree = fakeTree({ 999: 50, 50: 1, 100: 50, 300: 50 })
    await info(100, [100, 50], ['k1'])
    const server = await ControlServer.start({
      runDir: run,
      handler: fakeHandler({ autojoin: async () => ({ accepted: true }) }),
      agentKind: 'claude-code',
      pid: 300,
      ancestorPids: [300, 50],
      localKeys: ['k3'],
    })
    try {
      const { bridge, result } = await callBridge({ runDir: run, pid: 999, tree, localKey: 'k1' }, 'end', {
        local_key: 'k1',
      })
      expect(bridge.pid).toBe(300)
      expect(result).toEqual({})
      const bridges = await discoverBridges({ runDir: run, pid: 999, tree })
      const results = await broadcastToBridges(bridges, 'autojoin', {
        local_key: 'k',
        agent_kind: 'claude-code',
        workspace: '/w',
      })
      expect(results.map((r) => [r.bridge.pid, r.ok])).toEqual([
        [100, false],
        [300, true],
      ])
      expect(await errorCode(callBridge({ runDir: run, pid: 1, tree }, 'end', { local_key: 'k' }))).toBe(
        'not_connected',
      )
    } finally {
      await server.close()
    }
  })

  it('fails with not_connected when no bridge answers', async () => {
    const tree = fakeTree({ 999: 50, 50: 1, 100: 50 })
    await info(100, [100, 50])
    expect(await errorCode(callBridge({ runDir: run, pid: 999, tree }, 'end', { local_key: 'k' }))).toBe(
      'not_connected',
    )
  })
})

describe('line framing', () => {
  it('reassembles split UTF-8 and skips blank lines', () => {
    const reader = new LineReader(100)
    const bytes = new TextEncoder().encode('héllo\n\r\n{"a":1}\r\nrest')
    expect(reader.push(bytes.subarray(0, 2))).toEqual([])
    expect(reader.push(bytes.subarray(2))).toEqual([{ line: 'héllo' }, { line: '{"a":1}' }])
    expect(reader.push(new TextEncoder().encode('\n'))).toEqual([{ line: 'rest' }])
  })

  it('reports overflow once', () => {
    const reader = new LineReader(4)
    expect(reader.push(new TextEncoder().encode('ok\n123456'))).toEqual([{ line: 'ok' }, { overflow: true }])
    expect(reader.push(new TextEncoder().encode('\n'))).toEqual([])
    expect(new LineReader(2).push(new TextEncoder().encode('abc\n'))).toEqual([{ overflow: true }])
  })

  it('queues partial writes until drain, then ends', () => {
    const written: number[] = []
    let ended = false
    const socket = {
      write: (data: Uint8Array) => {
        const n = Math.min(3, data.length)
        written.push(n)
        return n
      },
      end: () => {
        ended = true
      },
    }
    const writer = new LineWriter(socket)
    writer.writeLine('abcdef')
    writer.writeLine('gh')
    writer.end()
    expect(ended).toBe(false)
    writer.drain()
    writer.drain()
    writer.drain()
    expect(ended).toBe(true)
    expect(written.reduce((a, b) => a + b, 0)).toBe(10)
  })
})

describe('Dispatcher without sockets', () => {
  it('answers notifications with invalid_request', async () => {
    const replies: string[] = []
    const dispatcher = new Dispatcher({ handler: fakeHandler() })
    await dispatcher.handleLine('{"jsonrpc":"2.0","method":"end"}', new AbortController().signal, (t) => {
      replies.push(t)
      return true
    })
    expect(JSON.parse(replies[0] ?? '{}').error.data.code).toBe('invalid_request')
  })

  it('stays silent when the connection is already gone', async () => {
    const replies: string[] = []
    const closed = new AbortController()
    closed.abort()
    const dispatcher = new Dispatcher({ handler: fakeHandler() })
    await dispatcher.handleLine(
      '{"jsonrpc":"2.0","id":1,"method":"activity","params":{"local_key":"k","state":"idle"}}',
      closed.signal,
      (t) => {
        replies.push(t)
        return true
      },
    )
    expect(replies).toEqual([])
  })

  it('reports a handler that throws synchronously as internal', async () => {
    const replies: string[] = []
    const dispatcher = new Dispatcher({
      handler: fakeHandler({
        end: () => {
          throw new Error('boom')
        },
      }),
    })
    await dispatcher.handleLine(
      '{"jsonrpc":"2.0","id":1,"method":"end","params":{"local_key":"k"}}',
      new AbortController().signal,
      (t) => {
        replies.push(t)
        return true
      },
    )
    expect(JSON.parse(replies[0] ?? '{}').error.data.code).toBe('internal')
  })
})
