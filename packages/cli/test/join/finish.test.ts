import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { rm } from 'node:fs/promises'
import { join as joinPath } from 'node:path'
import { type ProcessTree, peersPaths, socketPathFor, writeBridgeInfo } from '@agent-peers/core'
import { runJoin } from '../../src/join/run'
import { installFakeClaude, installFakeClaudeDesktop, installFakeCodex } from '../helpers/fake-agents'
import { type JoinWorld, output, roomTexts, startJoinWorld } from '../helpers/join-world'

let w: JoinWorld
beforeEach(async () => {
  w = await startJoinWorld()
})
afterEach(async () => {
  await w.stop()
})

async function run(
  url: string,
  options: Parameters<typeof runJoin>[1],
  env: Record<string, string>,
  extra = {},
) {
  const io = w.io(env)
  const code = await runJoin(url, options, io, w.deps(extra))
  return { code, ...output(io) }
}

const finish = (out: string) => out.slice(out.indexOf('[agent-peers] FINISH:')).trimEnd()

describe('FINISH per agent', () => {
  it('Codex CLI (--here inside codex)', async () => {
    await installFakeCodex(w.m)
    const result = await run(w.inviteUrl, { here: true }, { CODEX_THREAD_ID: 'thread-1' })
    expect(result.code).toBe(0)
    expect(result.out).toContain('session thread-1')
    expect(result.out).toContain('ask: $peers:ask @alice <question> · who: $peers:who')
    expect(finish(result.out)).toBe(
      '[agent-peers] FINISH:\n  Codex CLI: restart codex (codex resume --last) → open /hooks → trust "peers" → send any message (e.g. $peers:who)',
    )
    expect((await w.local.readAutojoin())[0]).toMatchObject({ agent: 'codex', local_key: 'thread-1' })
  })

  it('Claude Desktop (-a from a terminal) uses its fixed session key', async () => {
    await installFakeClaudeDesktop(w.m)
    const result = await run(w.inviteUrl, { agent: ['claude-desktop'] }, {})
    expect(result.code).toBe(0)
    expect(result.out).toContain('session claude-desktop@bob-mbp')
    expect(result.out).toContain('ask: say "ask @alice <question>" in a chat')
    expect(finish(result.out)).toContain(
      'Claude Desktop: quit and reopen Claude, then set agent-peers tools to "Always allow"',
    )
    expect((await w.local.readAutojoin())[0]?.local_key).toBe('claude-desktop@bob-mbp')
  })

  it('no agent at all: membership only, a bootstrap key and the add hint', async () => {
    const result = await run(w.inviteUrl, { yes: true }, {})
    expect(result.code).toBe(0)
    expect(result.out).toContain('[3/7] install: skipped: no supported agent selected')
    expect(result.out).toContain('session bootstrap-01JBOOTSTRAP')
    expect(finish(result.out)).toContain('install agent-peers into your coding agent (agent-peers add)')
    expect((await roomTexts(w)).some((t) => t === 'hello from @payments-api — other · payments-api')).toBe(
      true,
    )
  })
})

interface FakeBridge {
  stop(): void
}

/** A bridge's run files and a control socket that answers `autojoin` with `accepted`. */
async function fakeBridge(pid: number, keys: readonly string[], accepted: boolean): Promise<FakeBridge> {
  const run = peersPaths(w.m.peersHome).run
  await writeBridgeInfo(run, {
    pid,
    ancestor_pids: [],
    agent_kind: 'claude-code',
    local_keys: [...keys],
    started_at: 0,
  })
  const server = Bun.listen({
    unix: socketPathFor(run, pid),
    socket: {
      data(socket) {
        socket.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, result: { accepted } })}\n`)
      },
    },
  })
  return { stop: () => server.stop(true) }
}

const FAKE_PID = 999_999
const tree: ProcessTree = {
  lookup: async () => undefined,
  isAlive: (pid) => pid === process.pid || pid === FAKE_PID,
}

describe('already installed: control-socket autojoin', () => {
  async function secondRoom(): Promise<string> {
    const created = await w.alice.client.request('room.create', {
      session_id: w.alice.session.sessionId,
      name: 'infra',
      handle: 'alice',
    })
    return created.invite_url
  }

  it('exactly one bridge accepting means nothing to do; the live key is not reused', async () => {
    await installFakeClaude(w.m)
    const env = { CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: 'cc-bob' }
    expect((await run(w.inviteUrl, { here: true }, env)).code).toBe(0)
    const bridge = await fakeBridge(process.pid, ['cc-bob'], true)
    try {
      const result = await run(await secondRoom(), { here: true }, env, { processTree: tree })
      expect(result.code).toBe(0)
      expect(result.out).toContain('session bootstrap-01JBOOTSTRAP')
      expect(finish(result.out)).toBe(
        '[agent-peers] FINISH:\n  nothing to do: @payments-api is live in "infra" now',
      )
      const entry = (await w.local.readAutojoin()).find((e) => e.room_id !== w.roomId)
      expect(entry?.local_key).toBe('bootstrap-01JBOOTSTRAP0000000000000')
    } finally {
      bridge.stop()
    }
  })

  it('two bridges accepting falls back to the normal finishing step', async () => {
    await installFakeClaude(w.m)
    const env = { CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: 'cc-bob' }
    expect((await run(w.inviteUrl, { here: true }, env)).code).toBe(0)
    const bridges = [await fakeBridge(process.pid, [], true), await fakeBridge(FAKE_PID, [], true)]
    try {
      const result = await run(await secondRoom(), { here: true }, env, { processTree: tree })
      expect(finish(result.out)).toContain('Claude Code: type /reload-plugins --force')
    } finally {
      for (const bridge of bridges) bridge.stop()
      await rm(joinPath(peersPaths(w.m.peersHome).run), { recursive: true, force: true })
    }
  })
})
