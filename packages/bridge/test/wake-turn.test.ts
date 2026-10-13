import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { join } from 'node:path'
import { carriedAskIds } from '../src/injectors/claude-code/events'
import { INJECT_LEASE_MS } from '../src/session/bridge-session'
import { type ClaudeSetup, ccSession as session, setupClaude } from './helpers/claude-session'
import { eventually, startWorld, type World } from './helpers/world'

let world: World

beforeEach(async () => {
  world = await startWorld()
})
afterEach(async () => {
  await world.stop()
})

/** The waiter took @home's ask (the wake is queued in Claude Code) and the woken turn reported busy. */
async function woken(prepare?: (s: ClaudeSetup) => Promise<void>) {
  const s = await setupClaude(world)
  await s.ctl('register', { local_key: 'cc-1', source: 'resume' })
  await prepare?.(s)
  const waiting = s.ctl('wait', { local_key: 'cc-1', timeout_ms: 4000 })
  const asked = await s.alice.session.ask({ room_id: s.roomId, to: 'work', text: 'code name?' })
  expect((await waiting)?.envelope).toContain(`ask_id ${asked.id}`)
  await s.ctl('activity', { local_key: 'cc-1', state: 'busy' })
  return { ...s, askId: asked.id }
}

const prompt = (s: ClaudeSetup, carries?: readonly string[]) =>
  s.ctl('activity', {
    local_key: 'cc-1',
    state: 'busy',
    turn_start: true,
    ...(carries ? { carries: [...carries] } : {}),
  })

const gateWrite = (s: ClaudeSetup, name: string) =>
  s.ctl('gate', { local_key: 'cc-1', tool: 'Write', input: { file_path: join(s.workspace, name) } })

// Live regression (test/live/claude-code.live.test.ts): Claude Code submits an asyncRewake wake as a
// queued prompt that fires UserPromptSubmit, sometimes after the user's own prompt (the wake is
// absorbed mid-turn). Neither prompt may close the woken peer turn with "no reply", and the gate
// must stay on until the turn ends.
describe('a peer turn woken by the waiter', () => {
  it('survives the user prompt that runs first and the wake prompt that carries it', async () => {
    const s = await woken()
    const { alice, cc, askId } = s
    await prompt(s)
    expect(session(cc)?.queue.peerTurn?.ask_ids).toEqual([askId])
    const text = `<task-notification>…</task-notification>\n[agent-peers] ASK from @home\nask_id ${askId}`
    expect(carriedAskIds(text)).toEqual([askId])
    await prompt(s, [askId])
    expect(session(cc)?.queue.peerTurn?.ask_ids).toEqual([askId])
    expect((await gateWrite(s, 'x.txt')).decision).toBe('deny')
    const replied = await cc.call('peers_reply', { ask_id: askId, text: 'pelican' })
    expect(replied.isError).toBe(false)
    const reply = await alice.notes.waitFor('msg.new', (n) => n.message.kind === 'reply')
    expect(reply.message.text).toBe('pelican')
  })

  it('does not nudge at the Stop of the user prompt that ran before the queued wake', async () => {
    const s = await woken()
    await prompt(s)
    const early = await s.ctl('turn_end', { local_key: 'cc-1', last_message: 'Hello!' })
    expect(early.reminder).toBeUndefined()
    expect(session(s.cc)?.queue.peerTurn?.ask_ids).toEqual([s.askId])
    await prompt(s, [s.askId])
    const own = await s.ctl('turn_end', { local_key: 'cc-1', last_message: 'ok' })
    expect(own.reminder).toContain(s.askId)
  })

  it('confirms what the overtaking prompt took at its held Stop: no second delivery', async () => {
    let outgoing = ''
    const s = await woken(async ({ cc }) => {
      const sent = await cc.call('peers_ask', { target: '@home', question: 'ping?', wait_seconds: 0 })
      outgoing = String(sent.structured?.ask_id)
    })
    await prompt(s)
    await s.alice.notes.waitFor('msg.new', (n) => n.message.kind === 'ask' && n.message.id === outgoing)
    await s.alice.session.claim(outgoing)
    await s.alice.session.reply({ ask_id: outgoing, text: 'pong', state: 'answered' })
    const taken = await eventually(
      async () => (await s.ctl('take', { local_key: 'cc-1', max_chars: 4000 })) ?? undefined,
    )
    expect(taken.envelope).toContain('REPLY from @home')
    const held = await s.ctl('turn_end', { local_key: 'cc-1', inject_ids: [taken.inject_id] })
    expect(held.reminder).toBeUndefined()
    const item = session(s.cc)?.queue.state.items.find((i) => i.inject_id === taken.inject_id)
    expect(item?.state).toBe('injected')
    s.advance(INJECT_LEASE_MS + 1000)
    expect(session(s.cc)?.queue.pendingCount()).toBe(0)
    expect(await s.ctl('take', { local_key: 'cc-1', max_chars: 4000 })).toBeNull()
  })

  it('re-delivers a lost wake inline on the next prompt instead of gating a second blind turn', async () => {
    const s = await woken()
    await prompt(s)
    expect((await s.ctl('turn_end', { local_key: 'cc-1' })).reminder).toBeUndefined()
    // The wake never came (Esc dropped it): the next prompt's take hands the ask over inline.
    await prompt(s)
    expect(session(s.cc)?.queue.peerTurn?.ask_ids).toEqual([s.askId])
    const taken = await s.ctl('take', { local_key: 'cc-1', max_chars: 4000 })
    expect(taken?.envelope).toContain(`ask_id ${s.askId}`)
    expect((await gateWrite(s, 'y.txt')).decision).toBe('deny')
    const end = await s.ctl('turn_end', { local_key: 'cc-1', inject_ids: [taken?.inject_id ?? ''] })
    expect(end.reminder).toContain(s.askId)
    await s.cc.call('peers_reply', { ask_id: s.askId, text: 'pelican' })
    const reply = await s.alice.notes.waitFor('msg.new', (n) => n.message.kind === 'reply')
    expect(reply.message.text).toBe('pelican')
  })

  it('is still closed with "no reply" when a later prompt comes after the wake was carried', async () => {
    const s = await woken()
    await prompt(s, [s.askId])
    // Interrupted: no Stop. The user's next prompt abandons the peer turn as before.
    await prompt(s)
    expect(session(s.cc)?.queue.peerTurn).toBeNull()
    const failed = await s.alice.notes.waitFor('msg.new', (n) => n.message.kind === 'reply')
    expect(failed.message.text).toBe('no reply')
  })
})
