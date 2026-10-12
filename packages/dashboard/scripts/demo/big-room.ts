/**
 * The big room (DASHBOARD §4.3 "Big rooms", mockup 05): ~120 people with two agents each, most of
 * them offline, a few busy, and a long queue of knocks. Members connect in small batches.
 */
import type { Hub } from '@agent-peers/hub'
import { type AgentSpec, type ConnectOptions, connectAgent, type DemoAgent } from './agents'
import { bigRoomAgents, generatedNames } from './data'
import { waitForOffline } from './wait'

export interface BigRoomOptions {
  readonly name: string
  readonly members: number
  /** Members whose two agents stay online. */
  readonly online: number
  /** Online agents marked busy. */
  readonly busy: number
  readonly knocks: number
  readonly connect?: ConnectOptions
}

export interface BigRoom {
  readonly roomId: string
  /** The agents that stay connected (close them on shutdown). */
  readonly online: readonly DemoAgent[]
}

const BATCH = 12

const KNOCK_NOTES = [
  '新同学报到，想进来问问入职流程',
  '我是新来的前端，想让 agent 看看新人文档',
  '想让我的 agent 问问本地环境怎么搭',
  '',
] as const

async function inBatches<T, R>(
  items: readonly T[],
  run: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = []
  for (let start = 0; start < items.length; start += BATCH) {
    const batch = items.slice(start, start + BATCH)
    results.push(...(await Promise.all(batch.map((item, i) => run(item, start + i)))))
  }
  return results
}

/** Joins one member's two agents; returns the agents still online. */
async function seatMember(
  hub: Hub,
  url: string,
  name: string,
  index: number,
  room: { readonly roomId: string; readonly code: string },
  options: BigRoomOptions,
): Promise<readonly DemoAgent[]> {
  const { token } = hub.services.members.create(name)
  const specs: readonly AgentSpec[] = bigRoomAgents(index)
  const agents = await Promise.all(specs.map((spec) => connectAgent(url, token, name, spec, options.connect)))
  const [first, second] = agents
  if (first === undefined || second === undefined) throw new Error('big room: expected two agents')
  await first.joinByInvite(room.code, `${name}-1`)
  await second.join(room.roomId, `${name}-2`)
  if (index >= options.online) {
    await Promise.all(agents.map((agent) => agent.disconnect()))
    await waitForOffline(
      hub,
      agents.map((agent) => agent.sessionId),
    )
    return []
  }
  if (index * 2 < options.busy) await first.handle.update({ activity: 'busy', summary: '正在回答一个问题' })
  if (index * 2 + 1 < options.busy) await second.handle.update({ activity: 'busy' })
  return agents
}

async function knock(
  hub: Hub,
  url: string,
  name: string,
  index: number,
  roomId: string,
  options: BigRoomOptions,
) {
  const { token } = hub.services.members.create(name)
  const agent = await connectAgent(
    url,
    token,
    name,
    { key: 'k', kind: 'claude-code', title: '新人报到' },
    options.connect,
  )
  const note = KNOCK_NOTES[index % KNOCK_NOTES.length] ?? ''
  await agent.handle.knock(roomId, note === '' ? undefined : note)
  await agent.disconnect()
  await waitForOffline(hub, [agent.sessionId])
}

export async function seedBigRoom(
  hub: Hub,
  url: string,
  owner: DemoAgent,
  options: BigRoomOptions,
): Promise<BigRoom> {
  const created = await owner.createRoom({
    name: options.name,
    handle: `${owner.spec.key}-onb`,
    description: '2026 届新人入职：环境、规范、谁负责什么，问 agent 就行',
  })
  const room = { roomId: created.roomId, code: created.inviteCode }
  const names = generatedNames(options.members)
  const seated = await inBatches(names, (name, i) => seatMember(hub, url, name, i, room, options))
  await inBatches(generatedNames(options.knocks, 'new-'), (name, i) =>
    knock(hub, url, name, i, room.roomId, options),
  )
  return { roomId: room.roomId, online: seated.flat() }
}
