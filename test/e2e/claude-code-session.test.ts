/**
 * Claude Code session continuity and host checks:
 * - /clear starts a new conversation that supersedes the old one (handle and asks move over);
 * - a hub connection dropped from the hub side is re-established and reattached by the bridge;
 * - Cursor running the imported Claude Code plugin's hooks gets `{}` and touches nothing.
 */
import { afterEach, describe, expect, it } from 'bun:test'
import type { ClaudeCodeAgent, DesktopAgent } from './support/agents'
import { claudePayload, hookJson, runClaudeHook } from './support/claude-hooks'
import { askRoundTrip, askState } from './support/flows'
import { eventually } from './support/wait'
import { cardFor, createWorld, joinRoom, seenAs, type World } from './support/world'

let world: World | undefined
afterEach(async () => {
  await world?.cleanup()
  world = undefined
})

async function claudeAndAsker(w: World) {
  const asker = (await w.agent(await w.machine('asker'), 'claude-desktop')) as DesktopAgent
  await joinRoom(asker, w, 'asker')
  const cc = (await w.agent(await w.machine('laptop'), 'claude-code', { key: 'conv-1' })) as ClaudeCodeAgent
  await joinRoom(cc, w, 'work')
  await cc.start()
  return { asker, cc }
}

const spec = (asker: DesktopAgent, cc: ClaudeCodeAgent, question: string) => ({
  from: asker,
  fromHandle: 'asker',
  to: cc,
  toHandle: 'work',
  question,
  answer: `answer to: ${question}`,
})

describe('e2e: Claude Code sessions', () => {
  it('an ask that arrives mid-turn gets its own wake; it never joins the turn that is ending', async () => {
    world = await createWorld()
    const { asker, cc } = await claudeAndAsker(world)
    const first = await asker.ok('peers_ask', { target: '@work', question: 'first?', wait_seconds: 1 })
    const firstId = String(first.structured?.ask_id)
    expect((await cc.receive()).askId).toBe(firstId)
    // While Claude works on the first ask, a second one is queued for @work.
    const second = await asker.ok('peers_ask', { target: '@work', question: 'second?', wait_seconds: 1 })
    const secondId = String(second.structured?.ask_id)
    await cc.ok('peers_reply', { ask_id: firstId, text: 'one' })
    // Stop and the re-armed waiter run in parallel: no nudge about an ask Claude has not seen.
    expect(await cc.endTurn('done with the first')).toEqual({})
    expect((await cc.receive()).askId).toBe(secondId)
    await askState(world, secondId, 'working')
    await cc.ok('peers_reply', { ask_id: secondId, text: 'two' })
    expect(await cc.endTurn('done with the second')).toEqual({})
    await askState(world, secondId, 'answered')
  }, 120_000)

  it('/clear supersedes: the new conversation inherits @work and its queued asks', async () => {
    world = await createWorld()
    const { asker, cc } = await claudeAndAsker(world)
    const before = await cardFor(world, 'work')
    // An ask queued for @work while the user is busy in the old conversation (no waiter yet).
    cc.killWaiters()
    await cc.hook('UserPromptSubmit', { prompt: 'refactor the client' })
    const queued = await asker.ok('peers_ask', { target: '@work', question: 'still there?', wait_seconds: 1 })
    const queuedId = String(queued.structured?.ask_id)
    expect(queued.text).toContain('pending · @work: online, busy')

    const run = await cc.switchTo('conv-2', 'clear')
    expect(run.exitCode).toBe(0)
    // The new conversation is told its handle (SessionStart additionalContext).
    expect(JSON.stringify(hookJson(run))).toContain('@work in room')

    const after = await eventually('the handle on the new session', async () => {
      const card = await cardFor(world as World, 'work')
      return card.session_id !== before.session_id ? card : undefined
    })
    const old = (await world.hub.sessions()).find((c) => c.session_id === before.session_id)
    expect(old?.connection).toBe('offline')
    expect(old?.rooms).toEqual([])
    expect(after.member).toBe('laptop')

    const got = await cc.receive()
    expect(got.askId).toBe(queuedId)
    await askState(world, queuedId, 'working')
    await cc.ok('peers_reply', { ask_id: queuedId, text: 'yes, in a fresh conversation' })
    await cc.endTurn('replied')
    await askState(world, queuedId, 'answered')
    const who = await cc.ok('peers_who')
    expect(who.text).toContain('this session: conv-2')
    await askRoundTrip(world, spec(asker, cc, 'and a live one?'))
  }, 120_000)

  it('reconnects and reattaches after the hub drops its socket', async () => {
    world = await createWorld()
    const { asker, cc } = await claudeAndAsker(world)
    const card = await cardFor(world, 'work')
    const conn = world.hub.hub.registry.all().find((c) => c.sessions.has(card.session_id))
    expect(conn).toBeDefined()
    conn?.ws.close(1011, 'simulated network failure')
    await eventually('the bridge to reattach on a new connection', () => {
      const next = world?.hub.hub.registry.all().find((c) => c.sessions.has(card.session_id))
      return next !== undefined && next.id !== conn?.id ? next : undefined
    })
    const again = await cardFor(world, 'work')
    expect(again.session_id).toBe(card.session_id)
    expect(again.connection).toBe('online')
    await askRoundTrip(world, spec(asker, cc, 'did you survive the outage?'))
  }, 120_000)

  it('Cursor running the Claude Code hooks: every hook is a no-op', async () => {
    world = await createWorld()
    const { asker, cc } = await claudeAndAsker(world)
    cc.killWaiters()
    const pending = await asker.ok('peers_ask', { target: '@work', question: 'cursor?', wait_seconds: 1 })
    const askId = String(pending.structured?.ask_id)
    const sessionsBefore = (await world.hub.sessions()).length
    const cursorEnv = { CURSOR_VERSION: '3.20.1' }
    for (const event of ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'Stop'] as const) {
      const viaEnv = await runClaudeHook(
        cc.machine,
        event,
        claudePayload(cc.machine, event, 'cursor-conv'),
        cursorEnv,
      )
      expect([viaEnv.exitCode, hookJson(viaEnv)]).toEqual([0, {}])
      const viaInput = await runClaudeHook(
        cc.machine,
        event,
        claudePayload(cc.machine, event, 'conv-1', { cursor_version: '3.20.1' }),
      )
      expect([viaInput.exitCode, hookJson(viaInput)]).toEqual([0, {}])
    }
    // Nothing was registered and the pending ask was not taken.
    expect((await world.hub.sessions()).length).toBe(sessionsBefore)
    expect((await world.hub.ask(world.room.roomId, askId))?.ask?.state).not.toBe('working')
    // The real Claude Code prompt hook still delivers it.
    const prompt = hookJson(await cc.hook('UserPromptSubmit', { prompt: 'next task' }))
    expect(JSON.stringify(prompt)).toContain(`ask_id ${askId}`)
    await seenAs(world, 'work', 'online')
  }, 120_000)
})
