import { describe, expect, it } from 'bun:test'
import { type Clock, InjectQueue, type SessionJournal } from '@agent-peers/core'
import type { Activity, ReplyState } from '@agent-peers/protocol'
import { pullInjector } from '../src/inject/injector'
import { Delivery, type DeliveryHost } from '../src/session/delivery'
import { ChangeSignal, type PeerMessage } from '../src/session/signals'
import { Turns } from '../src/session/turns'
import { descriptorFor } from '../src/surface/surfaces'

const clock: Clock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
}

const ask = (id: string) =>
  ({
    id,
    room_id: 'r1',
    kind: 'ask',
    ts: Date.now(),
    seq: 1,
    to: ['work'],
    text: id,
  }) as unknown as PeerMessage

function journal(failInjected = false): SessionJournal {
  return {
    markClaimed: async () => undefined,
    markInjected: async () => {
      if (failInjected) throw new Error('disk full')
    },
    markRead: async () => undefined,
  } as unknown as SessionJournal
}

function host(options: { failJournal?: boolean; hooked?: boolean } = {}) {
  const queue = new InjectQueue<PeerMessage>({
    claim: async () => undefined,
    render: (item) => `ENV ${item.id}`,
    canNudge: true,
  })
  const lines: string[] = []
  const h: DeliveryHost = {
    queue,
    changes: new ChangeSignal(),
    journal: Promise.resolve(journal(options.failJournal)),
    accepting: true,
    ended: false,
    hooked: options.hooked ?? true,
    target: { localKey: 'k', surface: 'claude-code', activity: 'idle', hooked: options.hooked ?? true },
    log: (line) => lines.push(line),
  }
  const delivery = new Delivery(h, {
    descriptor: descriptorFor('claude-code'),
    injector: pullInjector(),
    clock,
  })
  return { queue, delivery, lines }
}

describe('Delivery', () => {
  it('re-queues a hand-out at once when journaling it fails', async () => {
    const { queue, delivery } = host({ failJournal: true })
    queue.enqueue(ask('A1'))
    await expect(delivery.handOut('take', 1000)).rejects.toThrow('disk full')
    expect(queue.state.items[0]?.state).toBe('pending')
    expect(queue.peerTurn).toBeNull()
  })

  it('confirms inline hand-outs and keeps waiter hand-outs leased', async () => {
    const { queue, delivery } = host()
    queue.enqueue(ask('A1'))
    queue.enqueue(ask('A2'))
    await delivery.handOut('take', 1000, { inline: true })
    await delivery.handOut('wait', 1000)
    expect(queue.state.items.map((i) => i.state)).toEqual(['injected', 'handed_out'])
    delivery.confirmHandedOut()
    expect(queue.state.items.map((i) => i.state)).toEqual(['injected', 'injected'])
  })

  it('holds asks back from unattended channels while the gate is inactive', async () => {
    const { queue, delivery } = host({ hooked: false })
    queue.enqueue(ask('A1'))
    expect(delivery.gateInactive).toBe(true)
    expect(await delivery.handOut('wait', 1000)).toBeNull()
    expect(delivery.heldAsks()).toBe(1)
    expect((await delivery.handOut('take', 1000))?.item.id).toBe('A1')
    delivery.stop()
  })
})

describe('Turns', () => {
  it('attempts every fallback reply even when one fails', async () => {
    const { queue, delivery, lines } = host()
    const sent: string[] = []
    const turns = new Turns({
      queue,
      delivery,
      reply: async (askId: string, _text: string, _state: ReplyState) => {
        if (askId === 'A1') throw new Error('hub hiccup')
        sent.push(askId)
      },
      setActivity: (_state: Activity) => undefined,
      presence: { noteTurnEnd: () => undefined },
      log: (line) => lines.push(line),
    })
    queue.enqueue(ask('A1'))
    queue.enqueue(ask('A2'))
    await delivery.handOut('wait', 1000)
    await delivery.handOut('wait', 1000)
    expect((await turns.end({})).kind).toBe('nudge')
    const outcome = await turns.end({})
    expect(outcome.kind).toBe('fallback')
    expect(sent).toEqual(['A2'])
    expect(lines.join('\n')).toContain('fallback reply to A1 failed: Error: hub hiccup')
    expect(queue.peerTurn).toBeNull()
  })

  it('binds a peer turn to the first turn id, rebinds on the carrier prompt and unbinds at the end', async () => {
    const { queue, delivery } = host()
    const turns = new Turns({
      queue,
      delivery,
      reply: async () => undefined,
      setActivity: () => undefined,
      presence: { noteTurnEnd: () => undefined },
      log: () => undefined,
    })
    turns.bind('t0')
    expect(turns.turnId).toBeUndefined()
    queue.enqueue(ask('A1'))
    await delivery.handOut('take', 1000, { inline: true })
    turns.bind('t1')
    turns.bind('t2')
    expect(turns.turnId).toBe('t1')
    turns.expectCarrier()
    await turns.begin('t3')
    expect(turns.turnId).toBe('t3')
    expect(turns.hooksNameTurns).toBe(false)
    turns.noteTurnId('t3')
    expect(turns.hooksNameTurns).toBe(true)
    await turns.end({})
    await turns.end({})
    expect(turns.turnId).toBeUndefined()
    expect(turns.gatedAskIds()).toEqual(['A1'])
  })
})
