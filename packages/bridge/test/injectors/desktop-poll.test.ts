import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { injectorFor } from '../../src/injectors/index'
import { eventually, startWorld, type World } from '../helpers/world'

let world: World

beforeEach(async () => {
  world = await startWorld()
})
afterEach(async () => {
  await world.stop()
})

describe('claude-desktop poll tier', () => {
  it('keeps envelopes in the inbox for peers_inbox and never pushes', async () => {
    const alice = await world.peer('alice')
    const room = await world.room(alice, 'team', 'home')
    const desk = await world.bridge('claude-desktop', {
      injector: injectorFor('claude-desktop', { env: {} }),
    })
    const joined = await desk.call('peers_join', { invite: room.inviteUrl, handle: 'work', remember: 'none' })
    expect(joined.isError).toBe(false)
    const session = desk.bridge.runtime?.registry.list()[0]
    expect(session?.tier).toBe('poll')
    const asked = await alice.session.ask({ room_id: room.roomId, to: 'work', text: 'ping from home' })
    const inbox = await eventually(async () => {
      const out = await desk.call('peers_inbox')
      return out.text.includes('ping from home') ? out : undefined
    })
    expect(inbox.text).toContain(asked.id)
    expect(session?.queue.state.items.some((item) => item.channel === 'push')).toBe(false)
  })
})
