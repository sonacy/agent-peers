import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { join } from 'node:path'
import type { Injector, InjectTarget } from '../src/inject/injector'
import { eventually, startWorld, type World } from './helpers/world'

let world: World

beforeEach(async () => {
  world = await startWorld()
})
afterEach(async () => {
  await world.stop()
})

const meta = (threadId: string) => ({ 'x-codex-turn-metadata': { thread_id: threadId } })

describe('bridge lifecycle', () => {
  it('re-queues an ask journaled before a restart that was never injected', async () => {
    const alice = await world.peer('alice')
    const room = await world.room(alice, 'team', 'home')
    const token = world.member('carol')
    const homeDir = join(world.dir, 'carol')
    const first = await world.bridge('codex', { token, homeDir })
    await first.call('peers_join', { invite: room.code, handle: 'work', remember: 'none' }, meta('t-1'))
    const asked = await alice.session.ask({ room_id: room.roomId, to: 'work', text: 'survive a restart?' })
    const session = first.bridge.runtime?.registry.get('t-1')
    await eventually(() => (session?.queue.pendingCount() ? true : undefined))
    await first.close()
    const second = await world.bridge('codex', { token, homeDir })
    // The plugin's hooks run (the gate is active), so listen mode may hand asks out.
    await second.call('peers_hook', { hook_event_name: 'SessionStart', session_id: 't-1', source: 'resume' })
    const out = await eventually(async () => {
      const got = await second.call('peers_wait', { timeout_seconds: 1 }, meta('t-1'))
      return got.text.includes(asked.id) ? got : undefined
    })
    expect(out.text).toContain('survive a restart?')
  })

  it('pushes through an injector that can reach the idle session', async () => {
    const pushed: string[] = []
    let mode: 'delivered' | 'unsupported' = 'unsupported'
    const injector: Injector = {
      kind: 'fake-queue',
      canPush: (target: InjectTarget) => target.hooked,
      push: async (envelope) => {
        pushed.push(envelope)
        return mode
      },
      tier: (target) => (target.hooked ? 'push' : undefined),
      close: async () => undefined,
    }
    const alice = await world.peer('alice')
    const room = await world.room(alice, 'team', 'home')
    const codex = await world.bridge('codex', { token: world.member('dan'), injector })
    await codex.call('peers_join', { invite: room.code, handle: 'work', remember: 'none' }, meta('t-1'))
    await codex.call('peers_hook', { hook_event_name: 'SessionStart', session_id: 't-1', source: 'startup' })
    const session = codex.bridge.runtime?.registry.get('t-1')
    expect(session?.tier).toBe('push')
    await alice.session.ask({ room_id: room.roomId, to: 'work', text: 'first' })
    await eventually(() => (pushed.length === 1 ? true : undefined))
    expect(session?.queue.pendingCount()).toBe(1)
    mode = 'delivered'
    session?.setActivity('idle')
    await eventually(() => (pushed.length === 2 ? true : undefined))
    await session?.settled()
    expect(session?.queue.pendingCount()).toBe(0)
    expect(pushed[1]).toContain('first')
  })

  it('drops its sessions when the hub revokes the token, and reports unauthorized after', async () => {
    const alice = await world.peer('alice')
    const room = await world.room(alice, 'team', 'home')
    const token = world.member('erin')
    const desk = await world.bridge('claude-desktop', { token })
    await desk.call('peers_join', { invite: room.code, handle: 'work', remember: 'none' })
    const memberId = world.hub.services.members.authenticate(token)?.id as string
    world.hub.services.members.revokeTokens(memberId)
    await eventually(() => (desk.bridge.runtime?.registry.size === 0 ? true : undefined))
    expect(desk.bridge.runtime?.connection.hub).toBeUndefined()
    const after = await desk.call('peers_who')
    expect(after.text).toContain('unauthorized')
  })

  it('refuses a second hub in one bridge (v0)', async () => {
    const alice = await world.peer('alice')
    const room = await world.room(alice, 'team', 'home')
    const desk = await world.bridge('claude-desktop', { token: world.member('fred') })
    await desk.call('peers_join', { invite: room.code, handle: 'work', remember: 'none' })
    await desk.home.setCredential('https://elsewhere.example', { member_token: 'not-used' })
    const other = await desk.call('peers_join', { invite: 'https://elsewhere.example/j/7K3QX9TZ4M2BHC8D' })
    expect(other.text).toContain('forbidden')
    expect(other.text).toContain('second hub')
  })
})
