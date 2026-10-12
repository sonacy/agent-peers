/**
 * One e2e world: a hub with one room, a watcher in it, and the simulated machines and agents a test
 * starts. `cleanup()` stops everything and removes every temp dir, also after a failed test.
 */
import { expect } from 'bun:test'
import { type Agent, type AgentOptions, startAgent } from './agents'
import { type E2eHub, type E2eRoom, startE2eHub } from './hub'
import { createMachine, type Machine } from './machine'
import type { Surface } from './profiles'
import { eventually } from './wait'
import { startWatcher, type Watcher } from './watcher'

export interface World {
  readonly hub: E2eHub
  readonly room: E2eRoom
  readonly watcher: Watcher
  machine(name: string): Promise<Machine>
  agent(machine: Machine, surface: Surface, options?: AgentOptions): Promise<Agent>
  cleanup(): Promise<void>
}

export async function createWorld(roomName = 'lab'): Promise<World> {
  const hub = await startE2eHub()
  const room = await hub.createRoom(roomName)
  const watcher = await startWatcher(hub, room)
  let machines: readonly Machine[] = []
  let agents: readonly Agent[] = []
  return {
    hub,
    room,
    watcher,
    async machine(name) {
      const machine = await createMachine(name)
      machines = [...machines, machine]
      return machine
    },
    async agent(machine, surface, options) {
      const agent = await startAgent(machine, surface, options)
      agents = [...agents, agent]
      return agent
    },
    async cleanup() {
      await Promise.allSettled(agents.map((a) => a.close()))
      await watcher.close().catch(() => undefined)
      await hub.stop()
      await Promise.allSettled(machines.map((m) => m.dispose()))
    },
  }
}

export interface JoinOptions {
  readonly remember?: 'workspace' | 'session' | 'none'
}

/** peers_join with the invite link (redeems it as a new member named after the machine), then ends the turn. */
export async function joinRoom(agent: Agent, world: World, handle: string, options: JoinOptions = {}) {
  const out = await agent.ok('peers_join', {
    invite: world.room.inviteUrl,
    handle,
    member: agent.machine.name,
    remember: options.remember ?? 'session',
  })
  expect(out.text).toContain(`joined room "${world.room.name}"`)
  expect(out.text).toContain(`as @${handle}`)
  await agent.endTurn('joined the room')
  return out
}

/** The live hub card holding `handle` in the room. */
export function cardFor(world: World, handle: string) {
  return eventually(`a card for @${handle}`, async () =>
    (await world.hub.sessions()).find(
      (card) => card.connection !== 'offline' && card.rooms.some((r) => r.handle === handle),
    ),
  )
}

/** Waits until the watcher saw @handle with `connection` (at or after log position `after`). */
export function seenAs(world: World, handle: string, connection: 'online' | 'offline' | 'stale', after = 0) {
  return world.watcher.waitPresence(
    `@${handle} ${connection}`,
    (event) => event.handle === handle && event.card.connection === connection,
    after,
  )
}
