import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdir, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { type ControlOp, type ControlParamsInput, callControl } from '@agent-peers/core'
import { INJECT_LEASE_MS } from '../src/session/bridge-session'
import { WAITER_GRACE_MS } from '../src/session/presence'
import { nextPid, ccSession as session, setupClaude } from './helpers/claude-session'
import { eventually, startWorld, type World } from './helpers/world'

let world: World

beforeEach(async () => {
  world = await startWorld()
})
afterEach(async () => {
  await world.stop()
})

const setup = (options: { injector?: boolean } = {}) => setupClaude(world, options)

describe('the asyncRewake waiter and the turn boundary', () => {
  it('never hands out while the session is mid-turn: the wake waits for Stop', async () => {
    const { ctl, alice, roomId, cc } = await setup()
    await ctl('register', { local_key: 'cc-1', source: 'startup' })
    await ctl('activity', { local_key: 'cc-1', state: 'busy', turn_start: true })
    const waiting = ctl('wait', { local_key: 'cc-1', timeout_ms: 4000 })
    const asked = await alice.session.ask({ room_id: roomId, to: 'work', text: 'mid-turn?' })
    await eventually(() => (session(cc)?.queue.pendingCount() ? true : undefined))
    await Bun.sleep(100)
    expect(session(cc)?.queue.peerTurn).toBeNull()
    expect(await ctl('turn_end', { local_key: 'cc-1', last_message: 'user task done' })).toEqual({})
    const woke = await waiting
    expect(woke?.envelope).toContain(asked.id)
    expect(session(cc)?.queue.peerTurn).toMatchObject({ ask_ids: [asked.id], started_by: 'wake' })
  })

  it('returns null at once when the session is disposed', async () => {
    const { ctl, cc } = await setup()
    await ctl('register', { local_key: 'cc-1', source: 'startup' })
    const started = Date.now()
    const waiting = ctl('wait', { local_key: 'cc-1', timeout_ms: 4000 })
    await Bun.sleep(50)
    session(cc)?.dispose()
    expect(await waiting).toBeNull()
    expect(Date.now() - started).toBeLessThan(2000)
  })

  it('advertises push only while a waiter can wake the session', async () => {
    const { ctl, cc, alice, roomId } = await setup({ injector: true })
    await ctl('register', { local_key: 'cc-1', source: 'startup' })
    expect(session(cc)?.tier).toBe('boundary')
    const waiting = ctl('wait', { local_key: 'cc-1', timeout_ms: 4000 })
    await eventually(() => (session(cc)?.tier === 'push' ? true : undefined))
    await alice.session.ask({ room_id: roomId, to: 'work', text: 'wake?' })
    expect(await waiting).not.toBeNull()
    await ctl('activity', { local_key: 'cc-1', state: 'busy' })
    // Woken: the turn's Stop re-arms, so push holds through the turn…
    expect(session(cc)?.tier).toBe('push')
    await ctl('turn_end', { local_key: 'cc-1' })
    await ctl('turn_end', { local_key: 'cc-1' })
    // …and lapses when no waiter came back within the grace period.
    expect(await ctl('wait', { local_key: 'cc-1', timeout_ms: 0 })).toBeNull()
    expect(session(cc)?.tier).toBe('push')
  })
})

describe('confirmation of inline hand-outs', () => {
  it('a take written to the hook is final; a reply read through peers_inbox is never re-delivered', async () => {
    const { ctl, alice, roomId, cc, advance } = await setup()
    await ctl('register', { local_key: 'cc-1', source: 'startup' })
    // This session asks @home; the reply arrives while nothing is polling.
    const sent = await cc.call('peers_ask', { target: '@home', question: 'ping?', wait_seconds: 0 })
    const askId = String(sent.structured?.ask_id)
    const delivered = alice.notes.waitFor('msg.new', (n) => n.message.kind === 'ask')
    await delivered
    await alice.session.claim(askId)
    await alice.session.reply({ ask_id: askId, text: 'pong', state: 'answered' })
    await eventually(() => (session(cc)?.queue.pendingCount() ? true : undefined))
    // The user's turn: the model reads the reply with peers_inbox (a tool result, not a lease).
    await ctl('activity', { local_key: 'cc-1', state: 'busy', turn_start: true })
    const inbox = await cc.call('peers_inbox')
    expect(inbox.text).toContain('REPLY from @home')
    // A take written to the prompt hook is final at once.
    await alice.session.ask({ room_id: roomId, to: 'work', text: 'via take' })
    const taken = await eventually(
      async () => (await ctl('take', { local_key: 'cc-1', max_chars: 4000 })) ?? undefined,
    )
    await eventually(() =>
      session(cc)?.queue.state.items.some((i) => i.inject_id === taken.inject_id && i.state === 'injected')
        ? true
        : undefined,
    )
    await cc.call('peers_reply', { ask_id: session(cc)?.queue.peerTurn?.ask_ids[0] ?? '', text: 'ok' })
    await ctl('turn_end', { local_key: 'cc-1' })
    // Long after the lease: nothing comes back to wake the session again.
    advance(INJECT_LEASE_MS + 1000)
    expect(session(cc)?.queue.pendingCount()).toBe(0)
    expect(await ctl('wait', { local_key: 'cc-1', timeout_ms: 200 })).toBeNull()
  })
})

describe('a peer turn left open by an interrupted or failed turn', () => {
  it('is closed with "no reply" when the user prompts again, and the gate lifts', async () => {
    const { ctl, alice, roomId, cc, workspace } = await setup()
    await ctl('activity', { local_key: 'cc-1', state: 'busy', turn_start: true })
    const asked = await alice.session.ask({ room_id: roomId, to: 'work', text: 'interrupted?' })
    await eventually(async () => (await ctl('take', { local_key: 'cc-1', max_chars: 4000 })) ?? undefined)
    // StopFailure keeps the peer turn (its output is ignored); no Stop follows.
    await ctl('activity', { local_key: 'cc-1', state: 'idle' })
    expect(session(cc)?.queue.peerTurn).not.toBeNull()
    await ctl('activity', { local_key: 'cc-1', state: 'busy', turn_start: true })
    expect(session(cc)?.queue.peerTurn).toBeNull()
    const failed = await alice.notes.waitFor('msg.new', (n) => n.message.kind === 'reply')
    expect(failed.message.re).toBe(asked.id)
    expect(failed.message.text).toBe('no reply')
    expect(failed.message.meta?.auto).toBeUndefined()
    const write = await ctl('gate', {
      local_key: 'cc-1',
      tool: 'Write',
      input: { file_path: join(workspace, 'mine.txt') },
    })
    expect(write.decision).toBe('allow')
  })
})

describe('the production gate', () => {
  it('follows symlinks out of the workspace and refuses searches that reach secrets', async () => {
    const { ctl, alice, roomId, workspace } = await setup()
    const outside = join(world.dir, 'outside')
    await mkdir(outside, { recursive: true })
    await writeFile(join(outside, 'notes.txt'), 'private')
    await symlink(outside, join(workspace, 'link'))
    await mkdir(join(workspace, 'certs'), { recursive: true })
    await writeFile(join(workspace, 'certs', 'server.pem'), '-----BEGIN')
    await writeFile(join(workspace, 'README.md'), 'hi')
    await ctl('activity', { local_key: 'cc-1', state: 'busy', turn_start: true })
    await alice.session.ask({ room_id: roomId, to: 'work', text: 'look around' })
    await eventually(async () => (await ctl('take', { local_key: 'cc-1', max_chars: 4000 })) ?? undefined)
    const gate = (tool: string, input: unknown) =>
      ctl('gate', { local_key: 'cc-1', tool, input, cwd: workspace })
    expect((await gate('Read', { file_path: join(workspace, 'link', 'notes.txt') })).decision).toBe('deny')
    expect((await gate('Grep', { pattern: 'BEGIN' })).reason).toContain('server.pem')
    expect((await gate('Grep', { pattern: 'BEGIN', glob: '*.md' })).decision).toBe('allow')
    expect((await gate('Bash', { command: 'rg BEGIN' })).decision).toBe('deny')
    expect((await gate('Read', { file_path: join(workspace, 'README.md') })).decision).toBe('allow')
  })

  it('keeps gating a peer turn across a dropped hub connection', async () => {
    const { ctl, alice, roomId, cc, workspace } = await setup()
    await ctl('activity', { local_key: 'cc-1', state: 'busy', turn_start: true })
    await alice.session.ask({ room_id: roomId, to: 'work', text: 'still gated?' })
    await eventually(async () => (await ctl('take', { local_key: 'cc-1', max_chars: 4000 })) ?? undefined)
    const rt = cc.bridge.runtime
    if (!rt) throw new Error('no runtime')
    const { client } = await rt.connection.ensure()
    await client.close('test drop')
    await eventually(() => (rt.registry.get('cc-1') === undefined ? true : undefined))
    expect(rt.registry.orphanTurn('cc-1')).toBeDefined()
    const write = await ctl('gate', {
      local_key: 'cc-1',
      tool: 'Write',
      input: { file_path: join(workspace, 'x.txt') },
      cwd: workspace,
    })
    expect(write.decision).toBe('deny')
    expect(rt.registry.get('cc-1')?.queue.peerTurn).not.toBeNull()
    expect(rt.registry.orphanTurn('cc-1')).toBeUndefined()
  })
})

describe('peers_inbox and the budget', () => {
  it('hands over-budget asks out inside a gated peer turn; pre-approval follows the gate', async () => {
    const alice = await world.peer('alice')
    const room = await world.room(alice, 'team', 'home')
    const pid = nextPid()
    const home = join(world.dir, `budget-${pid}`)
    await mkdir(home, { recursive: true })
    await writeFile(join(home, 'config.json'), JSON.stringify({ injection: { peer_turns_per_hour: 0 } }))
    const cc = await world.bridge('claude-code', {
      token: world.member('carol'),
      homeDir: home,
      env: { CLAUDE_CODE_SESSION_ID: 'cc-1', CLAUDECODE: '1' },
      controlSocket: { runDir: join(world.dir, `run-${pid}`), pid, ancestorPids: [pid, 1] },
    })
    await cc.call('peers_join', { invite: room.code, handle: 'work', remember: 'none' })
    const ctl = <Op extends ControlOp>(op: Op, params: ControlParamsInput<Op>) =>
      callControl(cc.bridge.controlSocketPath as string, op, params, { timeoutMs: 5000 })
    const asked = await alice.session.ask({ room_id: room.roomId, to: 'work', text: 'flood' })
    await eventually(() => (session(cc)?.queue.pendingCount() ? true : undefined))
    // The prompt hook's take finds the budget used up: the ask goes to the inbox, not the turn.
    await ctl('activity', { local_key: 'cc-1', state: 'busy', turn_start: true })
    expect(await ctl('take', { local_key: 'cc-1', max_chars: 4000 })).toBeNull()
    expect(
      session(cc)
        ?.queue.inboxOnly()
        .map((i) => i.reason),
    ).toEqual(['over_budget'])
    await ctl('turn_end', { local_key: 'cc-1' })
    // Outside a turn, a reply to an ask the gate never covered is left to the user.
    const before = await ctl('permission', {
      local_key: 'cc-1',
      tool: 'peers_reply',
      input: { ask_id: asked.id },
    })
    expect(before.allow).toBeUndefined()
    const inbox = await cc.call('peers_inbox')
    expect(inbox.text).toContain(asked.id)
    expect(session(cc)?.queue.peerTurn?.ask_ids).toEqual([asked.id])
    const bash = await ctl('gate', { local_key: 'cc-1', tool: 'Bash', input: { command: 'rm -rf /' } })
    expect(bash.decision).toBe('deny')
    await cc.call('peers_reply', { ask_id: asked.id, text: 'handled' })
    await ctl('turn_end', { local_key: 'cc-1' })
    const after = await ctl('permission', {
      local_key: 'cc-1',
      tool: 'peers_progress',
      input: { ask_id: asked.id },
    })
    expect(after.allow).toBe(true)
  })
})

describe('waiter grace period', () => {
  it('drops to boundary once no waiter came back', async () => {
    const { ctl, cc, advance } = await setup({ injector: true })
    await ctl('register', { local_key: 'cc-1', source: 'startup' })
    expect(await ctl('wait', { local_key: 'cc-1', timeout_ms: 0 })).toBeNull()
    expect(session(cc)?.tier).toBe('push')
    advance(WAITER_GRACE_MS + 1)
    expect(session(cc)?.tier).toBe('boundary')
  })
})
