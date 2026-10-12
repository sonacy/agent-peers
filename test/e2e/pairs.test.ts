/**
 * Cross-agent pairs: each side asks the other once, through the other surface's own delivery
 * mechanism, and gets the reply inline from peers_ask.
 * - Claude Code ⇄ Codex CLI (both directions)
 * - Claude Desktop ⇄ Codex desktop
 */
import { afterEach, describe, expect, it } from 'bun:test'
import type { Agent } from './support/agents'
import { askRoundTrip } from './support/flows'
import type { Surface } from './support/profiles'
import { createWorld, joinRoom, type World } from './support/world'

let world: World | undefined
afterEach(async () => {
  await world?.cleanup()
  world = undefined
})

interface Side {
  readonly agent: Agent
  readonly handle: string
}

async function side(w: World, surface: Surface, handle: string): Promise<Side> {
  const agent = await w.agent(await w.machine(handle), surface)
  await agent.start()
  await joinRoom(agent, w, handle)
  return { agent, handle }
}

async function exchange(w: World, a: Side, b: Side): Promise<void> {
  for (const [from, to] of [
    [a, b],
    [b, a],
  ] as const) {
    const outcome = await askRoundTrip(w, {
      from: from.agent,
      fromHandle: from.handle,
      to: to.agent,
      toHandle: to.handle,
      question: `@${to.handle}, which test runner does your workspace use? (from @${from.handle})`,
      answer: `bun test, says @${to.handle}`,
    })
    expect(outcome.delivery.envelope).toContain(`(member ${from.agent.machine.name}`)
    // The asker's own turn ends after the inline reply.
    await from.agent.endTurn(`@${to.handle} answered`)
  }
}

describe('e2e: cross-agent pairs', () => {
  it('Claude Code ⇄ Codex CLI', async () => {
    world = await createWorld()
    const cc = await side(world, 'claude-code', 'cc')
    const cx = await side(world, 'codex', 'cx')
    await exchange(world, cc, cx)
    // Codex received its ask through `codex queue` on its own thread.
    expect((await cx.agent.machine.queueCalls()).map((c) => c.thread)).toEqual([String(cx.agent.key)])
  }, 120_000)

  it('Codex CLI ⇄ Claude Code (Codex asks first)', async () => {
    world = await createWorld()
    const cx = await side(world, 'codex', 'cx')
    const cc = await side(world, 'claude-code', 'cc')
    await exchange(world, cx, cc)
  }, 120_000)

  it('Claude Desktop ⇄ Codex desktop', async () => {
    world = await createWorld()
    const cd = await side(world, 'claude-desktop', 'cd')
    const cxd = await side(world, 'codex-desktop', 'cxd')
    await exchange(world, cd, cxd)
    const cards = await world.hub.sessions()
    expect(cards.find((c) => c.member === 'cxd')?.agent.kind).toBe('codex-desktop')
    expect(cards.find((c) => c.member === 'cd')?.inject).toBe('poll')
  }, 120_000)
})
