import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import type { SessionHandle } from '@agent-peers/core'
import { PeersError } from '@agent-peers/protocol'
import { dashboardUrlFor, openInBrowser } from '../../src/commands/dashboard'
import { leaveCommand } from '../../src/commands/leave'
import { renameCommand } from '../../src/commands/rename'
import { runSay, sayCommand } from '../../src/commands/say'
import { runStatus, statusCommand } from '../../src/commands/status'
import { whoCommand } from '../../src/commands/who'
import { NetworkError } from '../../src/join/hub-http'
import { HandleTakenError, joinRoom, type RoomJoinInput } from '../../src/join/membership'
import { runJoin } from '../../src/join/run'
import { printFailure } from '../../src/join/shell-command'
import type { PeersDeps } from '../../src/join/types'
import { runRoot } from '../../src/root'
import { installFakeClaude } from '../helpers/fake-agents'
import { type JoinWorld, output, startJoinWorld } from '../helpers/join-world'
import { memoryIo } from '../helpers/world'

const AGENT = { CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: 'cc-bob' }

describe('--json', () => {
  let w: JoinWorld
  beforeEach(async () => {
    w = await startJoinWorld()
    await installFakeClaude(w.m)
  })
  afterEach(async () => {
    await w.stop()
  })

  async function cli(argv: readonly string[], deps: PeersDeps = w.deps()) {
    const io = w.io(AGENT)
    const code = await runRoot(argv, io, (scoped, setExit) =>
      [whoCommand, sayCommand, statusCommand, renameCommand, leaveCommand].map((factory) =>
        factory(scoped, setExit, deps),
      ),
    )
    return { code, ...output(io) }
  }

  it('join prints progress on stderr and one JSON document on stdout', async () => {
    const io = w.io(AGENT)
    expect(await runJoin(w.inviteUrl, { here: true, dryRun: true, json: true }, io, w.deps())).toBe(0)
    expect(JSON.parse(output(io).out)).toEqual({ ok: true, lines: [] })
    expect(output(io).err).toContain('[1/7] preview:')
    const sandboxed = w.io({ CODEX_THREAD_ID: 't', CODEX_SANDBOX: 'seatbelt' })
    expect(await runJoin(w.inviteUrl, { here: true, json: true }, sandboxed, w.deps())).toBe(3)
    const body = JSON.parse(output(sandboxed).out)
    expect(body.error.code).toBe('sandbox_blocked')
    expect(body.error.lines[0]).toBe("blocked by your agent's sandbox (CODEX_SANDBOX is set).")
    const bad = w.io(AGENT)
    expect(await runJoin('https://x/nope', { json: true }, bad, w.deps())).toBe(2)
    expect(JSON.parse(output(bad).out).error.code).toBe('invalid_params')
  })

  describe('shell commands', () => {
    beforeEach(async () => {
      const io = w.io(AGENT)
      const code = await runJoin(w.inviteUrl, { here: true }, io, w.deps())
      if (code !== 0) throw new Error(output(io).err)
    })

    it('who and say return their results as JSON', async () => {
      const who = await cli(['--json', 'who'])
      expect(who.code).toBe(0)
      expect(who.err).toBe('')
      const rooms = JSON.parse(who.out).rooms
      expect(rooms[0]).toMatchObject({ room: 'payments', room_id: w.roomId, handle: 'payments-api' })
      expect(rooms[0].members.map((m: { handle: string }) => m.handle).sort()).toEqual([
        'alice',
        'payments-api',
      ])
      const say = await cli(['say', 'hi', 'all', '--json'])
      expect(say.code).toBe(0)
      expect(JSON.parse(say.out)).toMatchObject({ room: 'payments', handle: 'payments-api' })
      expect(JSON.parse(say.out).message_id).toMatch(/\S+/)
      const status = await cli(['--json', 'status', 'busy', '--dnd'])
      expect(JSON.parse(status.out)).toEqual({ summary: 'busy', accepting: false })
      const rename = await cli(['--json', 'rename', 'a', 'title'])
      expect(JSON.parse(rename.out)).toMatchObject({ title: 'a title', rooms: [] })
      const leave = await cli(['--json', 'leave'])
      expect(JSON.parse(leave.out)).toMatchObject({
        room: 'payments',
        handle: 'payments-api',
        forgotten: true,
      })
    })

    it('failures are the JSON error envelope on stdout', async () => {
      const missing = await cli(['--json', 'say', 'hi', '--room', 'nope'])
      expect(missing.code).toBe(1)
      expect(missing.err).toBe('')
      expect(JSON.parse(missing.out).error.code).toBe('room_not_found')
      const human = await cli(['say', 'hi', '--room', 'nope'])
      expect(human.err).toMatch(/^agent-peers: .+ \[room_not_found\]\n$/)
      const usage = w.io(AGENT)
      expect(await runSay([], { json: true }, usage, w.deps())).toBe(2)
      expect(JSON.parse(output(usage).out).error).toEqual({
        code: 'invalid_params',
        message: 'usage: agent-peers say <text>',
      })
      const both = w.io(AGENT)
      expect(await runStatus([], { dnd: true, open: true }, both, w.deps())).toBe(2)
      expect(output(both).err).toBe('agent-peers: pass either --dnd or --open\n')
    })
  })
})

describe('printFailure', () => {
  it('maps unreachable and unknown failures', () => {
    const io = memoryIo({})
    expect(printFailure(io, true, new NetworkError('cannot reach h', 'ConnectionRefused'))).toBe(4)
    expect(printFailure(io, true, new Error('boom'))).toBe(1)
    expect(io.out.map((line) => JSON.parse(line).error.code)).toEqual(['unreachable', 'internal'])
  })
})

describe('dashboard link', () => {
  it('opens only http(s) links on the hub origin', () => {
    const hub = 'https://hub.example.com'
    expect(dashboardUrlFor('https://hub.example.com/app/login?c=X', hub)).toBe(
      'https://hub.example.com/app/login?c=X',
    )
    expect(dashboardUrlFor('https://x&calc.exe', hub)).toBeUndefined()
    expect(dashboardUrlFor('https://evil.example/app', hub)).toBeUndefined()
    expect(dashboardUrlFor('file:///Applications/Evil.app', hub)).toBeUndefined()
    expect(dashboardUrlFor('smb://hub.example.com/x', hub)).toBeUndefined()
    expect(dashboardUrlFor('-a Calculator', hub)).toBeUndefined()
    expect(dashboardUrlFor('https://u:p@hub.example.com/app', hub)).toBeUndefined()
    expect(dashboardUrlFor('http://127.0.0.1:7337/app/login?c=1', 'http://127.0.0.1:7337')).toBe(
      'http://127.0.0.1:7337/app/login?c=1',
    )
  })

  it('never routes the link through cmd.exe on Windows', async () => {
    // rundll32 does not exist here: the opener fails cleanly instead of running a shell.
    expect(await openInBrowser('https://x&calc.exe', 'win32')).toBe(false)
  })
})

describe('already joined', () => {
  const membership = { token: 't', member: 'bob', fresh: false, line: '' }

  function input(sameMember: boolean | undefined, owns: boolean): RoomJoinInput {
    const data = {
      handle: 'api',
      suggestion: 'api-2',
      ...(sameMember === undefined ? {} : { same_member: sameMember }),
    }
    const session = {
      view: { rooms: [] },
      join: async () => {
        throw new PeersError('handle_taken', '@api is taken', data)
      },
    } as unknown as SessionHandle
    return {
      session,
      roomId: 'r1',
      code: 'C',
      choice: { name: 'api', fixed: true },
      membership,
      ownsHandle: () => owns,
    }
  }

  it('believes the hub when it says the holder is another member', async () => {
    await expect(joinRoom(input(false, true))).rejects.toBeInstanceOf(HandleTakenError)
    expect(await joinRoom(input(true, false))).toMatchObject({ kind: 'already', handle: 'api' })
  })

  it('falls back to local memory when the hub does not say', async () => {
    expect(await joinRoom(input(undefined, true))).toMatchObject({ kind: 'already' })
    await expect(joinRoom(input(undefined, false))).rejects.toBeInstanceOf(HandleTakenError)
  })
})
