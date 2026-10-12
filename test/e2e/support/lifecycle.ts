/**
 * The full per-surface lifecycle (ARCHITECTURE §3, §5, §6; PROTOCOL §2.2, §4, §6.2; ONBOARDING §4):
 * install-free start → connect + join (invite) → presence online → receive an ask through the
 * surface's mechanism (claimed on hand-out) → peers_reply → the asker's inline peers_ask returns the
 * reply → rename (title + handle) → disconnect → offline → an ask queues → resume (new bridge, same
 * local_key) → reconnect + rejoin → the queued ask is delivered → close.
 *
 * The asker is a Claude Desktop session on its own machine (its own member), and a watcher in the
 * room records what every peer sees.
 */
import { expect } from 'bun:test'
import type { Agent, CodexAgent, Delivery, DesktopAgent } from './agents'
import { askRoundTrip, askState } from './flows'
import type { Surface } from './profiles'
import { profileFor } from './profiles'
import { eventually } from './wait'
import { cardFor, joinRoom, seenAs, type World } from './world'

export interface SurfaceSteps {
  /** Tier the card advertises once the surface is live (PROTOCOL §7.1). */
  readonly tier: 'push' | 'poll'
  /**
   * Tier advertised after the join, before the push channel is confirmed (Codex: `push` only once a
   * `codex queue` reached the thread); the card must move to `tier` after the first round trip.
   */
  readonly initialTier?: 'boundary'
  /** SessionStart while the machine has no credentials yet (install-free start). */
  preJoin(agent: Agent): Promise<void>
  /** Restart registration on the new bridge (SessionStart resume, or nothing). */
  resume(agent: Agent): Promise<void>
  /** How an ask queued while offline reaches the resumed session. */
  receiveQueued(agent: Agent): Promise<Delivery>
  /** Extra checks while the injected peer turn runs (tool gate). */
  duringPeerTurn?(agent: Agent, delivery: Delivery): Promise<void>
}

export interface LifecycleOptions {
  readonly steps: SurfaceSteps
  /** Called after the main round trip, before the rename (surface-specific extras). */
  readonly extra?: (ctx: { readonly agent: Agent; readonly asker: DesktopAgent }) => Promise<void>
}

const TARGET = 'target'
const RENAMED = 'target2'
const TITLE = '调研 e2e lifecycle'

async function setup(world: World, surface: Surface, steps: SurfaceSteps) {
  const askerMachine = await world.machine('asker')
  const asker = (await world.agent(askerMachine, 'claude-desktop')) as DesktopAgent
  await joinRoom(asker, world, 'asker')

  const machine = await world.machine(surface.replace('claude-', 'c'))
  const agent = await world.agent(machine, surface)
  // Install-free start: no credentials, no hub connection, but the tools are there.
  expect((await machine.localHome().readCredentials()).hubs).toEqual({})
  expect(await agent.bridge.toolNames()).toContain('peers_join')
  const who = await agent.call('peers_who')
  expect(who.isError).toBe(true)
  expect(who.text).toContain('not joined to any hub yet')
  await steps.preJoin(agent)
  return { asker, machine, agent }
}

async function connectAndJoin(world: World, surface: Surface, agent: Agent, steps: SurfaceSteps) {
  const mark = world.watcher.mark()
  await joinRoom(agent, world, TARGET, { remember: 'session' })
  const credentials = await agent.machine.localHome().readCredentials()
  expect(Object.keys(credentials.hubs)).toEqual([world.hub.url])
  expect((await agent.machine.autojoin()).map((e) => [e.room_id, e.handle])).toEqual([
    [world.room.roomId, TARGET],
  ])
  await seenAs(world, TARGET, 'online', mark)
  const card = await advertises(world, agent, steps.initialTier ?? steps.tier)
  expect(card.agent.kind).toBe(profileFor(surface).agentKind)
  expect(card.member).toBe(agent.machine.name)
}

async function advertises(world: World, agent: Agent, tier: string) {
  return eventually(`@${TARGET} advertising ${tier}`, async () => {
    const c = await cardFor(world, TARGET)
    return c.inject === tier ? c : undefined
  }).catch(async (error: unknown) => {
    throw new Error(
      `${String(error)}\ncard: ${JSON.stringify(await cardFor(world, TARGET))}\n${agent.bridge.stderr()}`,
    )
  })
}

async function rename(world: World, agent: Agent) {
  const mark = world.watcher.mark()
  const out = await agent.ok('peers_rename', { handle: RENAMED, title: TITLE })
  expect(out.text).toContain(`@${TARGET} → @${RENAMED}`)
  expect(out.text).toContain(`title: "${TITLE}"`)
  const card = await eventually('the hub card renamed', async () => {
    const c = await cardFor(world, RENAMED)
    return c.title === TITLE ? c : undefined
  })
  expect(card.rooms.map((r) => r.handle)).toEqual([RENAMED])
  const seen = await world.watcher.waitPresence(
    'the rename',
    (e) => e.handle === RENAMED && e.card.title === TITLE,
    mark,
  )
  expect(seen.room_id).toBe(world.room.roomId)
  expect((await agent.machine.autojoin()).map((e) => e.handle)).toEqual([RENAMED])
  const log = await world.hub.messages(world.room.roomId)
  expect(log.some((m) => m.kind === 'system' && m.text.includes(`@${TARGET} is now @${RENAMED}`))).toBe(true)
}

async function disconnectAndQueue(world: World, agent: Agent, asker: DesktopAgent) {
  const mark = world.watcher.mark()
  await agent.close()
  await seenAs(world, RENAMED, 'offline', mark)
  expect((await world.hub.sessionsOf(agent.machine.name))[0]?.connection).toBe('offline')
  const queued = await asker.ok('peers_ask', {
    target: `@${RENAMED}`,
    question: 'are you back yet?',
    wait_seconds: 1,
  })
  expect(queued.text).toContain(`pending · @${RENAMED}: offline`)
  const askId = String(queued.structured?.ask_id)
  await askState(world, askId, 'queued')
  return askId
}

async function resumeAndDeliver(
  world: World,
  surface: Surface,
  previous: Agent,
  steps: SurfaceSteps,
  queuedAsk: string,
) {
  const mark = world.watcher.mark()
  const agent = await world.agent(previous.machine, surface, previous.key ? { key: previous.key } : {})
  await steps.resume(agent)
  await seenAs(world, RENAMED, 'online', mark)
  const [card] = await world.hub.sessionsOf(previous.machine.name)
  expect(card?.rooms).toEqual([{ room_id: world.room.roomId, handle: RENAMED }])
  // The title is not checked here: a revive resets it to the default (known hub bug, see
  // title-persistence.test.ts).
  const got = await steps.receiveQueued(agent)
  expect(got.askId).toBe(queuedAsk)
  expect(got.envelope).toContain('are you back yet?')
  await askState(world, queuedAsk, 'working')
  await agent.ok('peers_reply', { ask_id: queuedAsk, text: 'yes, back online' })
  await agent.endTurn('yes, back online')
  await askState(world, queuedAsk, 'answered')
  return agent
}

export async function runLifecycle(world: World, surface: Surface, options: LifecycleOptions): Promise<void> {
  const { steps } = options
  const { asker, agent } = await setup(world, surface, steps)
  await connectAndJoin(world, surface, agent, steps)

  await askRoundTrip(
    world,
    {
      from: asker,
      fromHandle: 'asker',
      to: agent,
      toHandle: TARGET,
      question: 'what is the retry policy in the payments client?',
      answer: 'three retries with jittered backoff',
    },
    steps.duringPeerTurn
      ? (delivery) => steps.duringPeerTurn?.(agent, delivery) ?? Promise.resolve()
      : undefined,
  )
  if (steps.initialTier !== undefined) await advertises(world, agent, steps.tier)
  await options.extra?.({ agent, asker })

  await rename(world, agent)
  const queuedAsk = await disconnectAndQueue(world, agent, asker)
  const resumed = await resumeAndDeliver(world, surface, agent, steps, queuedAsk)

  asker.mode = 'inbox'
  const reply = await asker.receive()
  expect(reply.envelope).toContain(`[agent-peers] REPLY from @${RENAMED} to your ask ${queuedAsk}`)
  expect(reply.envelope).toContain('yes, back online')

  const mark = world.watcher.mark()
  await resumed.close()
  await seenAs(world, RENAMED, 'offline', mark)
}

/** Narrowing helpers for surface-specific steps. */
export const asCodex = (agent: Agent): CodexAgent => agent as CodexAgent
export const asDesktop = (agent: Agent): DesktopAgent => agent as DesktopAgent
