import { describe, expect, it } from 'bun:test'
import { PeersError } from '@agent-peers/protocol'
import { budgetResetsAt, decideReplyFallback, replyReminder, withinBudget } from '../../src/inject/policy'
import { InjectQueue, type InjectQueueOptions } from '../../src/inject/queue'
import * as S from '../../src/inject/state'
import { emptyQueueState, type InjectMessage, type PeerTurn } from '../../src/inject/types'

const errorCodeOf = (error: unknown): string => (error instanceof PeersError ? error.code : String(error))

const HOUR = 60 * 60 * 1000

const ask = (id: string, patch: Partial<InjectMessage> = {}): InjectMessage => ({
  id,
  room_id: 'room1',
  kind: 'ask',
  ts: 0,
  ...patch,
})

function setup(patch: Partial<InjectQueueOptions<InjectMessage>> = {}) {
  let now = 1_000
  let n = 0
  const claims: string[] = []
  const queue = new InjectQueue<InjectMessage>({
    claim: async (askId) => {
      claims.push(askId)
    },
    render: (item, max) => `ENV ${item.id} ${max}`,
    clock: { now: () => now },
    newInjectId: () => `inj${++n}`,
    leaseMs: 1_000,
    ...patch,
  })
  return {
    queue,
    claims,
    advance: (ms: number) => {
      now += ms
    },
  }
}

describe('InjectQueue', () => {
  it('claims an ask, hands it out once and starts a peer turn', async () => {
    const { queue, claims } = setup()
    queue.enqueue(ask('A1'))
    queue.enqueue(ask('A1'))
    const out = await queue.next('wait', 8000)
    expect(out?.envelope).toBe('ENV A1 8000')
    expect(out?.inject_id).toBe('inj1')
    expect(out?.item.channel).toBe('wait')
    expect(claims).toEqual(['A1'])
    expect(await queue.next('take', 8000)).toBeNull()
    expect(queue.peerTurn).toMatchObject({ ask_ids: ['A1'], room_ids: ['room1'], started_by: 'wake' })
  })

  it('drops asks whose claim fails terminally and moves on', async () => {
    const { queue } = setup({
      claim: async (id) => {
        if (id === 'A1') throw new PeersError('ask_closed')
        if (id === 'A2') throw new PeersError('ask_taken')
      },
    })
    queue.enqueue(ask('A1'))
    queue.enqueue(ask('A2'))
    queue.enqueue(ask('A3'))
    expect((await queue.next('take', 100))?.item.id).toBe('A3')
    expect(queue.state.items.map((i) => [i.id, i.state, i.reason])).toEqual([
      ['A1', 'dropped', 'ask_closed'],
      ['A2', 'dropped', 'ask_taken'],
      ['A3', 'handed_out', undefined],
    ])
    expect(queue.peerTurn?.started_by).toBe('user')
  })

  it('skips an ask after a transient claim failure without blocking the rest', async () => {
    let fail = true
    const errors: string[] = []
    const { queue, advance } = setup({
      claimRetryMs: 500,
      claim: async (id) => {
        if (fail && id === 'A1') throw new PeersError('rate_limited')
      },
      onClaimError: (id, error, outcome) => errors.push(`${id}:${errorCodeOf(error)}:${outcome}`),
    })
    queue.enqueue(ask('A1'))
    queue.enqueue({ id: 'R1', room_id: 'room1', kind: 'reply', re: 'X' })
    expect((await queue.next('take', 100))?.item.id).toBe('R1')
    expect(errors).toEqual(['A1:rate_limited:retry'])
    expect(queue.nextRetryAt()).toBe(1_500)
    expect(await queue.next('take', 100)).toBeNull()
    fail = false
    advance(500)
    expect((await queue.next('take', 100))?.item.id).toBe('A1')
    expect(queue.nextRetryAt()).toBeUndefined()
  })

  it('drops asks the hub will never let this session claim', async () => {
    const { queue } = setup({
      claim: async (id) => {
        if (id === 'A1') throw new PeersError('forbidden', 'only the holder of the target handle may claim')
        if (id === 'A2') throw new PeersError('target_not_found')
      },
    })
    queue.enqueue(ask('A1'))
    queue.enqueue(ask('A2'))
    queue.enqueue(ask('A3'))
    expect((await queue.next('wait', 100))?.item.id).toBe('A3')
    expect(queue.state.items.map((i) => [i.id, i.state, i.reason])).toEqual([
      ['A1', 'dropped', 'claim_refused'],
      ['A2', 'dropped', 'claim_refused'],
      ['A3', 'handed_out', undefined],
    ])
  })

  it('re-queues on lease expiry and on release; confirm makes it final', async () => {
    const { queue, advance, claims } = setup()
    queue.enqueue(ask('A1'))
    const first = await queue.next('push', 100)
    expect(queue.nextLeaseExpiry()).toBe(2_000)
    advance(1_000)
    expect(queue.pendingCount()).toBe(1)
    // The agent may have seen it: lease expiry never lifts the peer turn (or its gate).
    expect(queue.peerTurn).toMatchObject({ ask_ids: ['A1'], inject_ids: [first?.inject_id] })
    const second = await queue.next('wait', 100)
    expect(second?.inject_id).not.toBe(first?.inject_id)
    expect(queue.peerTurn?.ask_ids).toEqual(['A1'])
    expect(claims).toEqual(['A1', 'A1'])
    queue.release(second?.inject_id ?? '')
    const third = await queue.next('take', 100)
    queue.confirm([third?.inject_id ?? ''])
    advance(10_000)
    expect(queue.pendingCount()).toBe(0)
    expect(queue.state.items[0]).toMatchObject({
      state: 'injected',
      inject_id: third?.inject_id,
      channel: 'take',
    })
    expect(queue.nextLeaseExpiry()).toBeUndefined()
  })

  it('routes over-budget and stale asks to the inbox; replies bypass the budget', async () => {
    const { queue, advance } = setup({ peerTurnsPerHour: 1, maxReplayAgeMs: 500 })
    queue.enqueue(ask('A1'))
    const a1 = await queue.next('wait', 100)
    queue.turnEnd({ inject_ids: [a1?.inject_id ?? ''] })
    queue.enqueue(ask('A2'))
    queue.enqueue({ id: 'R1', room_id: 'room1', kind: 'reply', re: 'X' })
    queue.enqueue(ask('A3', { ts: 0 }), { replay: true })
    queue.enqueue({ id: 'C1', room_id: 'room1', kind: 'chat' })
    const r1 = await queue.next('wait', 100)
    expect(r1?.item.id).toBe('R1')
    expect(queue.peerTurn).toBeNull()
    queue.confirm([r1?.inject_id ?? ''])
    expect(queue.inboxOnly().map((i) => [i.id, i.reason])).toEqual([
      ['A2', 'over_budget'],
      ['A3', 'stale_replay'],
      ['C1', 'not_injectable'],
    ])
    advance(HOUR)
    queue.enqueue(ask('A4'))
    expect((await queue.next('wait', 100))?.item.id).toBe('A4')
  })

  it('joins a second ask into the current turn without spending budget', async () => {
    const { queue } = setup({ peerTurnsPerHour: 1 })
    queue.enqueue(ask('A1'))
    queue.enqueue(ask('A2', { room_id: 'room2' }))
    await queue.next('wait', 100)
    await queue.next('take', 100)
    expect(queue.peerTurn).toMatchObject({ ask_ids: ['A1', 'A2'], room_ids: ['room1', 'room2'] })
    expect(queue.state.turn_starts).toHaveLength(1)
  })

  it('notifies listeners on change', () => {
    const { queue } = setup()
    const seen: number[] = []
    const off = queue.onChange((s) => seen.push(s.items.length))
    queue.enqueue(ask('A1'))
    off()
    queue.enqueue(ask('A2'))
    expect(seen).toEqual([1])
  })

  it('returns null when the render-time state changed under it', async () => {
    const { queue } = setup({ render: () => 'x' })
    expect(await queue.next('take', 100)).toBeNull()
  })
})

describe('turn end and reply fallback', () => {
  it('done when every ask was replied', async () => {
    const { queue } = setup()
    queue.enqueue(ask('A1'))
    await queue.next('wait', 100)
    queue.markReplied('A1')
    queue.markReplied('A1')
    queue.markReplied('nope')
    expect(queue.turnEnd({})).toEqual({ kind: 'done' })
    expect(queue.peerTurn).toBeNull()
    expect(queue.turnEnd({})).toEqual({ kind: 'none' })
  })

  it('nudges once, then auto-replies with the final message for a sole wake ask', async () => {
    const { queue } = setup({ canNudge: true })
    queue.enqueue(ask('A1'))
    const out = await queue.next('wait', 100)
    const nudge = queue.turnEnd({ inject_ids: [out?.inject_id ?? ''] })
    expect(nudge).toMatchObject({ kind: 'nudge', ask_ids: ['A1'] })
    expect(queue.peerTurn?.nudged).toBe(true)
    expect(queue.state.items[0]?.state).toBe('injected')
    expect(queue.turnEnd({ last_message: '  the answer  ' })).toEqual({
      kind: 'fallback',
      replies: [{ ask_id: 'A1', state: 'answered', text: 'the answer', auto: true }],
    })
    expect(queue.peerTurn).toBeNull()
  })

  it('fails with "no reply" when the turn was not a sole wake or fallback is nudge', async () => {
    const take = setup()
    take.queue.enqueue(ask('A1'))
    await take.queue.next('take', 100)
    expect(take.queue.turnEnd({ last_message: 'x' })).toEqual({
      kind: 'fallback',
      replies: [{ ask_id: 'A1', state: 'failed', text: 'no reply', auto: false }],
    })
    const nudgeOnly = setup({ replyFallback: 'nudge' })
    nudgeOnly.queue.enqueue(ask('A1'))
    await nudgeOnly.queue.next('wait', 100)
    expect(nudgeOnly.queue.turnEnd({ last_message: 'x' })).toMatchObject({
      replies: [{ state: 'failed' }],
    })
  })
})

describe('policy helpers', () => {
  const turn: PeerTurn = {
    ask_ids: ['A1'],
    room_ids: ['r'],
    inject_ids: ['i'],
    started_at: 0,
    started_by: 'wake',
    replied: [],
    nudged: false,
  }

  it('decides the reply fallback', () => {
    expect(decideReplyFallback({ turn, ask_id: 'A1', last_message: 'ok', reply_fallback: 'auto' }).auto).toBe(
      true,
    )
    expect(decideReplyFallback({ turn, ask_id: 'A1', reply_fallback: 'auto' }).state).toBe('failed')
    expect(
      decideReplyFallback({
        turn: { ...turn, ask_ids: ['A1', 'A2'] },
        ask_id: 'A1',
        last_message: 'ok',
        reply_fallback: 'auto',
      }).state,
    ).toBe('failed')
  })

  it('computes the budget window', () => {
    expect(withinBudget([0, 10], 20, 2)).toBe(false)
    expect(withinBudget([0, 10], HOUR + 5, 2)).toBe(true)
    expect(budgetResetsAt([0, 10], 20, 2)).toBe(HOUR)
    expect(budgetResetsAt([0], 20, 2)).toBeUndefined()
  })

  it('words the reminder', () => {
    expect(replyReminder(['A1'])).toContain('peer ask A1')
    expect(replyReminder(['A1', 'A2'])).toContain('for each')
  })
})

describe('pure reducers', () => {
  it('ignore unknown ids and wrong states', () => {
    const state = S.enqueue(emptyQueueState(), ask('A1'), { now: 0 })
    expect(S.admit(state, 'zzz', 0, 1).admitted).toBe(false)
    expect(S.handOut(state, 'A1', { inject_id: 'i', channel: 'take', now: 0, leaseMs: 1 })).toBe(state)
    expect(S.release(state, 'nope')).toBe(state)
    expect(S.settleClaim(state, 'A1', 'ok')).toEqual(state)
    expect(S.markReplied(state, 'A1')).toBe(state)
  })
})
