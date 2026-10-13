import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdir, readFile, realpath } from 'node:fs/promises'
import { join } from 'node:path'
import { type ControlOp, type ControlParamsInput, callControl } from '@agent-peers/core'
import { type BridgeHarness, eventually, type Peer, startWorld, type World } from './helpers/world'

let world: World
let pids = 4300

beforeEach(async () => {
  world = await startWorld()
})
afterEach(async () => {
  await world.stop()
})

interface Setup {
  readonly alice: Peer
  readonly cc: BridgeHarness
  readonly roomId: string
  readonly workspace: string
  readonly memberId: string
  ctl<Op extends ControlOp>(op: Op, params: ControlParamsInput<Op>): ReturnType<typeof callControl<Op>>
}

/** A Claude Code bridge (session cc-1 from the env) that joined alice's room as @work. */
async function setup(): Promise<Setup> {
  const alice = await world.peer('alice')
  const room = await world.room(alice, 'team', 'home')
  const workspace = join(world.dir, 'ws')
  await mkdir(workspace, { recursive: true })
  pids += 1
  const token = world.member('carol')
  const memberId = world.hub.services.members.authenticate(token)?.id as string
  const cc = await world.bridge('claude-code', {
    token,
    env: { CLAUDE_CODE_SESSION_ID: 'cc-1', CLAUDECODE: '1' },
    cwd: workspace,
    controlSocket: { runDir: join(world.dir, `run-${pids}`), pid: pids, ancestorPids: [pids, 1] },
  })
  const joined = await cc.call('peers_join', { invite: room.code, handle: 'work', remember: 'none' })
  expect(joined.isError).toBe(false)
  const socket = cc.bridge.controlSocketPath as string
  return {
    alice,
    cc,
    roomId: room.roomId,
    workspace: await realpath(workspace),
    memberId,
    ctl: (op, params) => callControl(socket, op, params, { timeoutMs: 3000 }),
  }
}

describe('claude-code bridge', () => {
  it('warns when no hook reached the bridge within 30 s of initialize', async () => {
    let offset = 0
    const clock = {
      now: () => Date.now() + offset,
      setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
      clearTimeout: (handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    }
    const cc = await world.bridge('claude-code', {
      token: world.member('hal'),
      env: { CLAUDE_CODE_SESSION_ID: 'cc-h' },
      clock,
    })
    expect((await cc.call('peers_who')).text).not.toContain('hooks not running')
    offset = 31_000
    expect((await cc.call('peers_who')).text).toContain('hooks not running/trusted')
  })

  it('opens the CLAUDE_CODE_SESSION_ID session at initialize and advertises it in run/<pid>.json', async () => {
    const { cc } = await setup()
    const registry = cc.bridge.runtime?.registry
    expect(registry?.keys()).toEqual(['cc-1'])
    const info = JSON.parse(
      await readFile((cc.bridge.controlSocketPath as string).replace(/\.sock$/, '.json'), 'utf8'),
    )
    expect(info.local_keys).toEqual(['cc-1'])
    expect(info.agent_kind).toBe('claude-code')
    expect(registry?.get('cc-1')?.tier).toBe('poll')
  })

  it('register returns the model context and raises the tier to push', async () => {
    const { cc, ctl, alice, roomId } = await setup()
    const result = await ctl('register', { local_key: 'cc-1', source: 'startup' })
    expect(result.context).toContain('@work in room "team"')
    expect(cc.bridge.runtime?.registry.get('cc-1')?.tier).toBe('push')
    await eventually(async () => {
      const { members } = await alice.session.peers(roomId)
      return members.find((m) => m.handle === 'work')?.card.inject === 'push' ? true : undefined
    })
  })

  // Live regression: Claude Code's SessionStart carries `model`, but register dropped it, so cards
  // of Claude Code sessions never showed a model.
  it('register publishes the SessionStart model on the card', async () => {
    const { ctl, alice, roomId } = await setup()
    await ctl('register', { local_key: 'cc-1', source: 'startup', model: 'claude-haiku-5-5' })
    await eventually(async () => {
      const { members } = await alice.session.peers(roomId)
      return members.find((m) => m.handle === 'work')?.card.model === 'claude-haiku-5-5' ? true : undefined
    })
  })

  // Live regression: /peers:join in a session that started before any hub was joined. Its
  // SessionStart register failed (no hub yet), so the model must be re-applied on later hook ops.
  it('applies the SessionStart model once a first peers_join opened the session', async () => {
    const alice = await world.peer('alice')
    const room = await world.room(alice, 'team', 'home')
    pids += 1
    const cc = await world.bridge('claude-code', {
      env: { CLAUDE_CODE_SESSION_ID: 'cc-m', CLAUDECODE: '1' },
      controlSocket: { runDir: join(world.dir, `run-${pids}`), pid: pids, ancestorPids: [pids, 1] },
    })
    const socket = cc.bridge.controlSocketPath as string
    const ctl = <Op extends ControlOp>(op: Op, params: ControlParamsInput<Op>) =>
      callControl(socket, op, params, { timeoutMs: 3000 })
    await expect(
      ctl('register', { local_key: 'cc-m', source: 'startup', model: 'claude-haiku-5-5' }),
    ).rejects.toMatchObject({ code: 'unauthorized' })
    const joined = await cc.call('peers_join', { invite: room.inviteUrl, handle: 'work', remember: 'none' })
    expect(joined.isError).toBe(false)
    await ctl('turn_end', { local_key: 'cc-m', inject_ids: [] })
    await eventually(async () => {
      const { members } = await alice.session.peers(room.roomId)
      return members.find((m) => m.handle === 'work')?.card.model === 'claude-haiku-5-5' ? true : undefined
    })
  })

  it('delivers an ask through wait, nudges once, then auto-replies with the last message', async () => {
    const { ctl, alice, roomId } = await setup()
    await ctl('register', { local_key: 'cc-1', source: 'startup' })
    const waiting = ctl('wait', { local_key: 'cc-1', timeout_ms: 3000 })
    const asked = await alice.session.ask({ room_id: roomId, to: 'work', text: 'which db?' })
    const injected = await waiting
    expect(injected?.envelope).toContain(`ASK from @home`)
    expect(injected?.envelope).toContain(`ask_id ${asked.id}`)
    const first = await ctl('turn_end', { local_key: 'cc-1', last_message: 'postgres 16' })
    expect(first.reminder).toContain(asked.id)
    const second = await ctl('turn_end', { local_key: 'cc-1', last_message: 'postgres 16' })
    expect(second.reminder).toBeUndefined()
    const reply = await alice.notes.waitFor('msg.new', (n) => n.message.kind === 'reply')
    expect(reply.message.text).toBe('postgres 16')
    expect(reply.message.meta?.auto).toBe(true)
  })

  it('injects through take on prompt submit and fails the ask with "no reply" when unanswered', async () => {
    const { ctl, alice, roomId, cc } = await setup()
    await ctl('activity', { local_key: 'cc-1', state: 'busy' })
    const asked = await alice.session.ask({ room_id: roomId, to: 'work', text: 'status?' })
    const taken = await eventually(
      async () => (await ctl('take', { local_key: 'cc-1', max_chars: 4000 })) ?? undefined,
    )
    expect(taken.envelope).toContain(asked.id)
    expect(await ctl('take', { local_key: 'cc-1', max_chars: 4000 })).toBeNull()
    await ctl('turn_end', { local_key: 'cc-1', inject_ids: [taken.inject_id] })
    await ctl('turn_end', { local_key: 'cc-1' })
    const failed = await alice.notes.waitFor(
      'ask.updated',
      (n) => n.ask_id === asked.id && n.state === 'failed',
    )
    expect(failed.state).toBe('failed')
    expect(cc.bridge.runtime?.registry.get('cc-1')?.queue.peerTurn).toBeNull()
  })

  it('gates tools during a peer turn and pre-approves only peers_reply', async () => {
    const { ctl, alice, roomId, workspace, cc } = await setup()
    const outside = await ctl('gate', { local_key: 'cc-1', tool: 'Bash', input: { command: 'rm -rf /' } })
    expect(outside.decision).toBe('allow')
    const asked = await alice.session.ask({ room_id: roomId, to: 'work', text: 'read the readme' })
    await eventually(async () => (await ctl('take', { local_key: 'cc-1', max_chars: 4000 })) ?? undefined)
    const bash = await ctl('gate', { local_key: 'cc-1', tool: 'Bash', input: { command: 'rm -rf /' } })
    expect(bash.decision).toBe('deny')
    const send = await ctl('gate', {
      local_key: 'cc-1',
      tool: 'mcp__plugin_peers_peers__peers_send',
      input: {},
    })
    expect(send.decision).toBe('deny')
    const read = await ctl('gate', {
      local_key: 'cc-1',
      tool: 'Read',
      input: { file_path: join(workspace, 'README.md') },
      cwd: workspace,
    })
    expect(read.decision).toBe('allow')
    const ok = await ctl('permission', {
      local_key: 'cc-1',
      tool: 'peers_reply',
      input: { ask_id: asked.id },
    })
    expect(ok.allow).toBe(true)
    const no = await ctl('permission', { local_key: 'cc-1', tool: 'peers_join', input: {} })
    expect(no.allow).toBeUndefined()
    const relay = await cc.call('peers_ask', { target: '@home', question: 'relay?' })
    expect(relay.text).toContain('forbidden')
    const answered = await cc.call('peers_reply', { ask_id: asked.id, text: 'it says hi' })
    expect(answered.isError).toBe(false)
    const done = await ctl('turn_end', { local_key: 'cc-1' })
    expect(done.reminder).toBeUndefined()
  })

  it('supersedes the env session on /clear and moves the handle', async () => {
    const { ctl, cc, alice, roomId } = await setup()
    const result = await ctl('register', { local_key: 'cc-2', source: 'clear', supersedes: 'cc-1' })
    expect(result.context).toContain('@work')
    expect(cc.bridge.runtime?.registry.keys()).toEqual(['cc-2'])
    const { members } = await alice.session.peers(roomId)
    const work = members.find((m) => m.handle === 'work')
    expect(work?.card.session_id).toBe(cc.bridge.runtime?.registry.get('cc-2')?.sessionId)
  })

  it('infers the superseded session when /clear registers only the new key', async () => {
    const { ctl, cc } = await setup()
    await ctl('register', { local_key: 'cc-3', source: 'clear' })
    expect(cc.bridge.runtime?.registry.keys()).toEqual(['cc-3'])
    await ctl('register', { local_key: 'cc-4', source: 'startup' })
    expect(cc.bridge.runtime?.registry.keys()).toEqual(['cc-3', 'cc-4'])
  })

  it('registers unknown keys implicitly from any hook op and ends sessions', async () => {
    const { ctl, cc } = await setup()
    await ctl('activity', { local_key: 'cc-x', state: 'idle' })
    expect(cc.bridge.runtime?.registry.keys()).toContain('cc-x')
    const gate = await ctl('gate', { local_key: 'cc-y', tool: 'Read', input: {} })
    expect(gate.decision).toBe('allow')
    await eventually(() => (cc.bridge.runtime?.registry.get('cc-y') ? true : undefined))
    await ctl('end', { local_key: 'cc-x' })
    expect(cc.bridge.runtime?.registry.keys()).not.toContain('cc-x')
    const ambiguous = await cc.call('peers_who')
    expect(ambiguous.text).toContain('several sessions share this bridge')
    const keyed = await cc.call('peers_who', { session_key: 'cc-1' })
    expect(keyed.text).toContain('@work (you)')
    expect((await cc.call('peers_who', { session_key: 'nope' })).text).toContain('unknown session_key')
  })

  it('accepts autojoin only for its own key or workspace', async () => {
    const { ctl, workspace } = await setup()
    expect(
      (await ctl('autojoin', { local_key: 'cc-1', agent_kind: 'claude-code', workspace })).accepted,
    ).toBe(true)
    const other = join(world.dir, 'elsewhere')
    await mkdir(other)
    expect(
      (await ctl('autojoin', { local_key: 'zz', agent_kind: 'claude-code', workspace: other })).accepted,
    ).toBe(false)
  })

  it('reports activity to the hub, debounced', async () => {
    const { ctl, alice, roomId } = await setup()
    await ctl('activity', { local_key: 'cc-1', state: 'busy' })
    await eventually(async () => {
      const { members } = await alice.session.peers(roomId)
      return members.find((m) => m.handle === 'work')?.card.activity === 'busy' ? true : undefined
    })
  })

  it('applies session.patched from the dashboard: DND holds asks', async () => {
    const { ctl, cc, alice, roomId, memberId } = await setup()
    const session = cc.bridge.runtime?.registry.get('cc-1')
    const actor = { kind: 'member' as const, memberId }
    world.hub.services.rename.patch(actor, session?.sessionId as string, { accepting: false })
    await eventually(() => (session?.accepting === false ? true : undefined))
    await alice.session.ask({ room_id: roomId, to: 'work', text: 'held?' })
    await Bun.sleep(50)
    expect(await ctl('take', { local_key: 'cc-1', max_chars: 4000 })).toBeNull()
    world.hub.services.rename.patch(actor, session?.sessionId as string, { accepting: true })
    const taken = await eventually(
      async () => (await ctl('take', { local_key: 'cc-1', max_chars: 4000 })) ?? undefined,
    )
    expect(taken.envelope).toContain('held?')
  })
})
