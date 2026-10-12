/**
 * Regression: a revived session keeps its stored title. Titles change only through session.rename or
 * the dashboard (PROTOCOL §2.2), never because a restarted bridge sends its default title.
 */
import { afterEach, describe, expect, it } from 'bun:test'
import { eventually } from './support/wait'
import { cardFor, createWorld, joinRoom, type World } from './support/world'

let world: World | undefined
afterEach(async () => {
  await world?.cleanup()
  world = undefined
})

describe('e2e: renamed titles across restarts', () => {
  it('a renamed title survives a bridge restart (revive)', async () => {
    world = await createWorld()
    const machine = await world.machine('desk')
    const first = await world.agent(machine, 'claude-code', { key: 'conv-1' })
    await joinRoom(first, world, 'desk')
    await first.ok('peers_rename', { title: 'Release planning' })
    await eventually(
      'the renamed title',
      async () => (await cardFor(world as World, 'desk')).title === 'Release planning',
    )
    await first.close()
    // `claude --resume`: same session id, new bridge process (the card's default title is "desk").
    const second = await world.agent(machine, 'claude-code', { key: 'conv-1' })
    await second.start('resume')
    const card = await eventually('the resumed session online', async () => {
      const c = await cardFor(world as World, 'desk')
      return c.inject === 'push' ? c : undefined
    })
    expect(card.title).toBe('Release planning')
  }, 60_000)
})
