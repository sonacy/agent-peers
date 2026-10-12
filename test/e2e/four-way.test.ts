/**
 * One room with all four v0 surfaces (Claude Code, Claude Desktop, Codex CLI, Codex desktop): every
 * session asks every other session once and gets each reply inline. Each ask reaches its target
 * through that target's own mechanism (asyncRewake waiter, peers_wait, codex queue).
 */
import { afterEach, describe, expect, it } from 'bun:test'
import type { Agent } from './support/agents'
import { askRoundTrip } from './support/flows'
import { SURFACES, type Surface } from './support/profiles'
import { createWorld, joinRoom, type World } from './support/world'

let world: World | undefined
afterEach(async () => {
  await world?.cleanup()
  world = undefined
})

const HANDLES: Readonly<Record<Surface, string>> = {
  'claude-code': 'cc',
  'claude-desktop': 'cd',
  codex: 'cx',
  'codex-desktop': 'cxd',
}

describe('e2e: four-way room', () => {
  it('every surface asks every other surface once', async () => {
    world = await createWorld('everyone')
    const members: { readonly agent: Agent; readonly handle: string }[] = []
    for (const surface of SURFACES) {
      const handle = HANDLES[surface]
      const agent = await world.agent(await world.machine(handle), surface)
      await agent.start()
      await joinRoom(agent, world, handle)
      members.push({ agent, handle })
    }
    const who = await members[0]?.agent.ok('peers_who')
    for (const handle of Object.values(HANDLES)) expect(who?.text).toContain(`@${handle}`)

    const askIds: string[] = []
    for (const from of members) {
      for (const to of members) {
        if (from === to) continue
        const outcome = await askRoundTrip(world, {
          from: from.agent,
          fromHandle: from.handle,
          to: to.agent,
          toHandle: to.handle,
          question: `hello @${to.handle}, what are you working on? (from @${from.handle})`,
          answer: `@${to.handle} is testing agent-peers`,
        })
        askIds.push(outcome.askId)
        await from.agent.endTurn('got the answer')
      }
    }
    expect(new Set(askIds).size).toBe(12)
    const log = await world.hub.messages(world.room.roomId)
    const answered = log.filter((m) => m.kind === 'ask' && m.ask?.state === 'answered')
    expect(answered).toHaveLength(12)
    const replies = log.filter((m) => m.kind === 'reply')
    expect(new Set(replies.map((m) => m.re))).toEqual(new Set(askIds))
  }, 180_000)
})
