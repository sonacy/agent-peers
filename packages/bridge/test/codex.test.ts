import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { type BridgeHarness, eventually, type Peer, startWorld, type World } from './helpers/world'

/** Codex leaves template fields it cannot fill verbatim, e.g. `${turn_id}`. */
const UNFILLED_TURN = '$' + '{turn_id}'
const UNFILLED_TOOL = '$' + '{tool_name}'
const UNFILLED_CWD = '$' + '{cwd}'

let world: World

beforeEach(async () => {
  world = await startWorld()
})
afterEach(async () => {
  await world.stop()
})

const turn = (threadId: string, turnId = 'turn-1') => ({
  'x-codex-turn-metadata': { thread_id: threadId, turn_id: turnId, session_id: threadId },
})

interface Setup {
  readonly alice: Peer
  readonly codex: BridgeHarness
  readonly roomId: string
  readonly cwd: string
  hook(event: string, fields?: Record<string, unknown>): Promise<Record<string, unknown>>
}

async function setup(env: Record<string, string> = {}): Promise<Setup> {
  const alice = await world.peer('alice')
  const room = await world.room(alice, 'team', 'home')
  const cwd = join(world.dir, 'repo')
  await mkdir(cwd, { recursive: true })
  const codex = await world.bridge('codex', { token: world.member('dave'), env })
  const joined = await codex.call(
    'peers_join',
    { invite: room.code, handle: 'work', remember: 'none' },
    turn('t-1'),
  )
  expect(joined.isError).toBe(false)
  const hook = async (event: string, fields: Record<string, unknown> = {}) => {
    const out = await codex.call('peers_hook', {
      agent: 'codex',
      hook_event_name: event,
      session_id: 't-1',
      cwd,
      model: 'gpt-6-codex',
      turn_id: UNFILLED_TURN,
      ...fields,
    })
    expect(out.isError).toBe(false)
    return JSON.parse(out.text) as Record<string, unknown>
  }
  return { alice, codex, roomId: room.roomId, cwd, hook }
}

describe('codex bridge', () => {
  it('identifies the calling thread from _meta x-codex-turn-metadata', async () => {
    const { codex } = await setup()
    expect(codex.bridge.runtime?.registry.keys()).toEqual(['t-1'])
    const solo = await codex.call('peers_who')
    expect(solo.text).toContain('@work (you)')
    await codex.call('peers_inbox', {}, { 'x-codex-turn-metadata': JSON.stringify({ thread_id: 't-2' }) })
    expect(codex.bridge.runtime?.registry.keys()).toEqual(['t-1', 't-2'])
    const ambiguous = await codex.call('peers_who')
    expect(ambiguous.text).toContain('several sessions share this bridge')
    expect((await codex.call('peers_who', { session_key: 't-1' })).text).toContain('@work (you)')
  })

  it('SessionStart registers the thread and returns its context', async () => {
    const { hook, codex } = await setup()
    const out = await hook('SessionStart', { source: 'startup' })
    const specific = out.hookSpecificOutput as Record<string, unknown>
    expect(specific.hookEventName).toBe('SessionStart')
    expect(String(specific.additionalContext)).toContain('@work in room "team"')
    const session = codex.bridge.runtime?.registry.get('t-1')
    expect(session?.tier).toBe('boundary')
    expect(session?.workspace).toContain('repo')
  })

  it('UserPromptSubmit hands a pending ask over as additionalContext', async () => {
    const { hook, alice, roomId, codex } = await setup()
    await alice.session.ask({ room_id: roomId, to: 'work', text: 'ping?' })
    await eventually(() =>
      codex.bridge.runtime?.registry.get('t-1')?.queue.pendingCount() ? true : undefined,
    )
    const out = await hook('UserPromptSubmit')
    const specific = out.hookSpecificOutput as Record<string, unknown>
    expect(String(specific.additionalContext)).toContain('ASK from @home')
    expect(codex.bridge.runtime?.registry.get('t-1')?.activity).toBe('busy')
    expect(await hook('UserPromptSubmit')).toEqual({})
  })

  it('Stop delivers held envelopes, nudges once, then auto-replies', async () => {
    const { hook, alice, roomId, codex } = await setup()
    const asked = await alice.session.ask({ room_id: roomId, to: 'work', text: 'which port?' })
    await eventually(() =>
      codex.bridge.runtime?.registry.get('t-1')?.queue.pendingCount() ? true : undefined,
    )
    const delivered = await hook('Stop', { last_assistant_message: 'done with the user task' })
    expect(delivered.decision).toBe('block')
    expect(String(delivered.reason)).toContain(asked.id)
    const nudge = await hook('Stop', { last_assistant_message: '7337', stop_hook_active: 'true' })
    expect(nudge.decision).toBe('block')
    expect(String(nudge.reason)).toContain('peers_reply')
    expect(await hook('Stop', { last_assistant_message: '7337' })).toEqual({})
    const reply = await alice.notes.waitFor('msg.new', (n) => n.message.kind === 'reply')
    expect(reply.message.text).toBe('7337')
    expect(reply.message.meta?.auto).toBe(true)
    expect(codex.bridge.runtime?.registry.get('t-1')?.activity).toBe('idle')
  })

  it('PreToolUse denies tools off the allowlist during a peer turn', async () => {
    const { hook, alice, roomId, codex } = await setup()
    expect(await hook('PreToolUse', { tool_name: 'Bash', tool_input: '{"command":"rm -rf build"}' })).toEqual(
      {},
    )
    await alice.session.ask({ room_id: roomId, to: 'work', text: 'look around' })
    await eventually(() =>
      codex.bridge.runtime?.registry.get('t-1')?.queue.pendingCount() ? true : undefined,
    )
    await hook('UserPromptSubmit')
    const denied = await hook('PreToolUse', { tool_name: 'Bash', tool_input: '{"command":"rm -rf build"}' })
    const specific = denied.hookSpecificOutput as Record<string, unknown>
    expect(specific.permissionDecision).toBe('deny')
    expect(String(specific.permissionDecisionReason)).toContain('agent-peers')
    const relay = await codex.call('peers_send', { text: 'relay' }, turn('t-1'))
    expect(relay.text).toContain('forbidden')
    expect(await hook('PreToolUse', { tool_name: UNFILLED_TOOL })).toEqual({})
  })

  it('fails closed on paths when no hook reported the workspace', async () => {
    const { codex, alice, roomId } = await setup()
    const bare = (event: string, fields: Record<string, unknown> = {}) =>
      codex.call('peers_hook', { hook_event_name: event, session_id: 't-1', cwd: UNFILLED_CWD, ...fields })
    await alice.session.ask({ room_id: roomId, to: 'work', text: 'read secrets' })
    await eventually(() =>
      codex.bridge.runtime?.registry.get('t-1')?.queue.pendingCount() ? true : undefined,
    )
    await bare('UserPromptSubmit')
    const read = JSON.parse(
      (await bare('PreToolUse', { tool_name: 'Read', tool_input: { file_path: '/etc/hosts' } })).text,
    )
    expect(read.hookSpecificOutput.permissionDecision).toBe('deny')
    const askId = codex.bridge.runtime?.registry.get('t-1')?.queue.peerTurn?.ask_ids[0]
    const reply = JSON.parse(
      (await bare('PreToolUse', { tool_name: 'mcp__peers__peers_reply', tool_input: { ask_id: askId } }))
        .text,
    )
    expect(reply).toEqual({})
  })

  it('ignores hooks without any session id and unknown events', async () => {
    const { codex, hook } = await setup()
    const anonymous = await codex.call('peers_hook', { hook_event_name: 'Stop' })
    expect(JSON.parse(anonymous.text)).toEqual({})
    expect(await hook('SubagentStop')).toEqual({})
    const viaMeta = await codex.call('peers_hook', { hook_event_name: 'Notification' }, turn('t-3'))
    expect(JSON.parse(viaMeta.text)).toEqual({})
    expect(codex.bridge.runtime?.registry.keys()).toContain('t-3')
  })

  it('serves Codex desktop from the same tree, detected at runtime', async () => {
    const codex = await world.bridge('codex', {
      token: world.member('erin'),
      env: { CODEX_INTERNAL_ORIGINATOR_OVERRIDE: 'Codex Desktop' },
    })
    expect(codex.bridge.verdict?.surface).toBe('codex-desktop')
    expect(codex.bridge.runtime?.descriptor.agentKind).toBe('codex-desktop')
    const out = await codex.call('peers_who', {}, turn('d-1'))
    expect(out.text).toContain('not in any room')
  })

  it('peers_wait long-polls for the next ask (listen mode) and advertises push meanwhile', async () => {
    const { codex, alice, roomId, hook } = await setup()
    await hook('SessionStart', { source: 'startup' })
    const empty = await codex.call('peers_wait', { timeout_seconds: 0 }, turn('t-1'))
    expect(empty.text).toContain('no peer message yet')
    const waiting = codex.call('peers_wait', { timeout_seconds: 3 }, turn('t-1'))
    await eventually(() => (codex.bridge.runtime?.registry.get('t-1')?.tier === 'push' ? true : undefined))
    await alice.session.ask({ room_id: roomId, to: 'work', text: 'listening?' })
    const got = await waiting
    expect(got.text).toContain('listening?')
    expect(got.structured?.kind).toBe('ask')
  })

  it('peers_wait holds asks when the tool gate is not active (no hook reached the bridge)', async () => {
    const { codex, alice, roomId } = await setup()
    const asked = await alice.session.ask({ room_id: roomId, to: 'work', text: 'unattended?' })
    await eventually(() =>
      codex.bridge.runtime?.registry.get('t-1')?.queue.pendingCount() ? true : undefined,
    )
    const out = await codex.call('peers_wait', { timeout_seconds: 0 }, turn('t-1'))
    expect(out.text).not.toContain(asked.id)
    expect(out.text).toContain('tool gate is not active')
    expect(out.structured).toMatchObject({ held_asks: 1, reason: 'gate_inactive' })
    // The local user's explicit read still shows it (and claims it in a peer turn).
    const inbox = await codex.call('peers_inbox', {}, turn('t-1'))
    expect(inbox.text).toContain(asked.id)
  })

  it('refuses a turn-scoped peers_hook call that does not come from the peer turn', async () => {
    const { hook, alice, roomId, codex } = await setup()
    const session = () => codex.bridge.runtime?.registry.get('t-1')
    await alice.session.ask({ room_id: roomId, to: 'work', text: 'which port?' })
    await eventually(() => (session()?.queue.pendingCount() ? true : undefined))
    const prompt = await hook('UserPromptSubmit', { turn_id: 'turn-7' })
    expect(JSON.stringify(prompt)).toContain('ASK from @home')
    expect(session()?.turns.turnId).toBe('turn-7')
    // The model calling peers_hook itself: no turn id, a guessed one, or one that is not its own turn.
    expect(await hook('Stop', { turn_id: UNFILLED_TURN, last_assistant_message: 'x' })).toEqual({})
    expect(await hook('Stop', { turn_id: 'turn-8', last_assistant_message: 'x' })).toEqual({})
    const forged = await codex.call(
      'peers_hook',
      { hook_event_name: 'Stop', session_id: 't-1', turn_id: 'turn-x' },
      turn('t-1', 'turn-7'),
    )
    expect(JSON.parse(forged.text)).toEqual({})
    expect(await hook('UserPromptSubmit', { turn_id: UNFILLED_TURN })).toEqual({})
    expect(session()?.queue.peerTurn).not.toBeNull()
    // The real Stop of the bound turn ends it (with the one nudge first).
    const nudge = await hook('Stop', { turn_id: 'turn-7', last_assistant_message: 'x' })
    expect(nudge.decision).toBe('block')
  })

  it('closes a peer turn an interrupted Codex turn left open when the user prompts again', async () => {
    const { hook, alice, roomId, codex } = await setup()
    const session = () => codex.bridge.runtime?.registry.get('t-1')
    await alice.session.ask({ room_id: roomId, to: 'work', text: 'which port?' })
    await eventually(() => (session()?.queue.pendingCount() ? true : undefined))
    await hook('UserPromptSubmit', { turn_id: 'turn-1' })
    expect(session()?.queue.peerTurn?.started_by).toBe('user')
    // Esc: no Stop. The user's next prompt must not run gated or answer the peer with its own text.
    await hook('UserPromptSubmit', { turn_id: 'turn-2' })
    expect(session()?.queue.peerTurn).toBeNull()
    const reply = await alice.notes.waitFor('msg.new', (n) => n.message.kind === 'reply')
    expect(reply.message.text).toBe('no reply')
    const edit = await hook('PreToolUse', {
      tool_name: 'apply_patch',
      tool_input: '{"input":"*** Add File: a"}',
    })
    expect(edit).toEqual({})
  })

  it('PreToolUse fails closed during a peer turn when the hook itself errors', async () => {
    const { hook, alice, roomId, codex } = await setup()
    const rt = codex.bridge.runtime
    if (!rt) throw new Error('no runtime')
    await alice.session.ask({ room_id: roomId, to: 'work', text: 'look around' })
    await eventually(() => (rt.registry.get('t-1')?.queue.pendingCount() ? true : undefined))
    await hook('UserPromptSubmit')
    const original = rt.config
    Object.assign(rt, {
      config: async () => {
        throw new Error('config unreadable')
      },
    })
    const denied = await hook('PreToolUse', { tool_name: 'Read', tool_input: '{"file_path":"README.md"}' })
    expect(denied).toMatchObject({ hookSpecificOutput: { permissionDecision: 'deny' } })
    Object.assign(rt, { config: original })
    const ensure = rt.registry.ensure.bind(rt.registry)
    Object.assign(rt.registry, {
      ensure: async () => {
        throw new Error('registry down')
      },
    })
    const broken = await hook('PreToolUse', { tool_name: 'Bash', tool_input: '{"command":"ls"}' })
    expect(broken).toMatchObject({ hookSpecificOutput: { permissionDecision: 'deny' } })
    expect(await hook('PreToolUse', { tool_name: 'Bash', session_id: 't-9' })).toEqual({})
    Object.assign(rt.registry, { ensure })
  })
})
