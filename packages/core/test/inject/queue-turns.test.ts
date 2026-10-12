import { describe, expect, it } from 'bun:test'
import { InjectQueue, type InjectQueueOptions } from '../../src/inject/queue'
import * as S from '../../src/inject/state'
import { emptyQueueState, type InjectMessage } from '../../src/inject/types'

const ask = (id: string): InjectMessage => ({ id, room_id: 'room1', kind: 'ask', ts: 0 })
const reply = (id: string): InjectMessage => ({ id, room_id: 'room1', kind: 'reply', re: 'X' })

function setup(patch: Partial<InjectQueueOptions<InjectMessage>> = {}) {
  let now = 1_000
  let n = 0
  const queue = new InjectQueue<InjectMessage>({
    claim: async () => undefined,
    render: (item) => `ENV ${item.id}`,
    clock: { now: () => now },
    newInjectId: () => `inj${++n}`,
    leaseMs: 1_000,
    canNudge: true,
    ...patch,
  })
  return { queue, advance: (ms: number) => (now += ms) }
}

describe('deferred (queued) pushes', () => {
  it('joins the peer turn only when the turn carrying the ask starts', async () => {
    const { queue } = setup()
    queue.enqueue(ask('A1'))
    const out = await queue.next('push', 100, { deferTurn: true })
    expect(out?.item.id).toBe('A1')
    expect(queue.peerTurn).toBeNull()
    expect(queue.deferred).toEqual(['A1'])
    queue.confirm([out?.inject_id ?? ''])
    // A Stop of some other turn before the queued turn ran: nothing to nudge or fail.
    expect(queue.turnEnd({})).toEqual({ kind: 'none' })
    queue.activateDeferred()
    expect(queue.deferred).toEqual([])
    expect(queue.peerTurn).toMatchObject({ ask_ids: ['A1'], started_by: 'wake', inject_ids: ['inj1'] })
    queue.activateDeferred()
    expect(queue.peerTurn?.ask_ids).toEqual(['A1'])
  })

  it('does not defer replies and forgets a released deferred ask', async () => {
    const { queue } = setup()
    queue.enqueue(reply('R1'))
    queue.enqueue(ask('A1'))
    await queue.next('push', 100, { deferTurn: true })
    expect(queue.deferred).toEqual([])
    const out = await queue.next('push', 100, { deferTurn: true })
    queue.release(out?.inject_id ?? '')
    expect(queue.deferred).toEqual([])
    expect(S.activateDeferred(emptyQueueState(), 0)).toEqual(emptyQueueState())
  })
})

describe('abandonTurn', () => {
  it('fails unanswered asks with "no reply", never auto-sends, never nudges', async () => {
    const { queue } = setup()
    queue.enqueue(ask('A1'))
    queue.enqueue(ask('A2'))
    await queue.next('wait', 100)
    await queue.next('wait', 100)
    queue.markReplied('A2')
    expect(queue.abandonTurn()).toEqual({
      kind: 'fallback',
      replies: [{ ask_id: 'A1', state: 'failed', text: 'no reply', auto: false }],
    })
    expect(queue.peerTurn).toBeNull()
    expect(queue.abandonTurn()).toEqual({ kind: 'none' })
  })
})

describe('inbox-only asks', () => {
  it('are handed out once the local user opens the inbox, despite the budget', async () => {
    const { queue } = setup({ peerTurnsPerHour: 0 })
    queue.enqueue(ask('A1'))
    queue.enqueue({ id: 'C1', room_id: 'room1', kind: 'chat' })
    expect(await queue.next('take', 100)).toBeNull()
    expect(queue.inboxOnly().map((i) => i.reason)).toEqual(['over_budget', 'not_injectable'])
    const before = queue.state
    queue.reopenInboxOnly()
    expect(queue.state).not.toBe(before)
    const out = await queue.next('take', 100)
    expect(out?.item.id).toBe('A1')
    expect(queue.peerTurn).toMatchObject({ ask_ids: ['A1'], started_by: 'user' })
    expect(queue.inboxOnly().map((i) => i.id)).toEqual(['C1'])
    const same = queue.state
    queue.reopenInboxOnly()
    expect(queue.state).toBe(same)
  })
})

describe('filters', () => {
  it('hands out only matching items and leaves the rest pending', async () => {
    const { queue } = setup()
    queue.enqueue(ask('A1'))
    queue.enqueue(reply('R1'))
    const out = await queue.next('wait', 100, { filter: (item) => item.kind === 'reply' })
    expect(out?.item.id).toBe('R1')
    expect(await queue.next('wait', 100, { filter: (item) => item.kind === 'reply' })).toBeNull()
    expect(queue.pendingCount()).toBe(1)
  })
})
