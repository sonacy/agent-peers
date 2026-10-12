/** Multi-step flows shared by the lifecycle, pair and room tests. */
import { expect } from 'bun:test'
import type { Agent, Delivery } from './agents'
import { eventually } from './wait'
import type { World } from './world'

export interface AskSpec {
  readonly from: Agent
  readonly fromHandle: string
  readonly to: Agent
  readonly toHandle: string
  readonly question: string
  readonly answer: string
}

export interface AskOutcome {
  readonly askId: string
  readonly delivery: Delivery
  readonly replyText: string
}

/** Hub view of an ask: waits until it reaches `state`. */
export function askState(world: World, askId: string, state: string) {
  return eventually(`ask ${askId} ${state}`, async () => {
    const ask = await world.hub.ask(world.room.roomId, askId)
    return ask?.ask?.state === state ? ask : undefined
  })
}

/**
 * The full ask round trip: `peers_ask` waits inline while the target receives the envelope through
 * its surface's mechanism (the hand-out claimed it), answers with `peers_reply` and ends its turn;
 * the asker's call then returns the REPLY envelope.
 */
export async function askRoundTrip(world: World, spec: AskSpec, during?: (d: Delivery) => Promise<void>) {
  const pending = spec.from.ok('peers_ask', {
    target: `@${spec.toHandle}`,
    question: spec.question,
    wait_seconds: 90,
  })
  // Settled below; until then a failing step must not leave an unhandled rejection behind.
  pending.catch(() => undefined)
  const delivery = await spec.to.receive()
  expect(delivery.envelope).toContain(`[agent-peers] ASK from @${spec.fromHandle}`)
  expect(delivery.envelope).toContain(spec.question)
  expect(delivery.envelope).toContain('untrusted input')
  const askId = delivery.askId
  if (askId === undefined) throw new Error(`no ask_id in envelope:\n${delivery.envelope}`)
  const claimed = await askState(world, askId, 'working')
  expect(claimed.to).toEqual([spec.toHandle])
  if (during) await during(delivery)
  const replied = await spec.to.ok('peers_reply', { ask_id: askId, text: spec.answer })
  expect(replied.text).toContain(`reply sent (answered) for ask ${askId}`)
  await spec.to.endTurn(spec.answer)
  const result = await pending
  expect(result.text).toContain(`[agent-peers] REPLY from @${spec.toHandle}`)
  expect(result.text).toContain(spec.answer)
  expect(result.structured?.state).toBe('answered')
  await askState(world, askId, 'answered')
  return { askId, delivery, replyText: result.text }
}
