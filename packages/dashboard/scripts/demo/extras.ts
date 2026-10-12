/**
 * The rest of the mockup's world, for design QA:
 * - discoverable rooms gulei is not in (找房间 rows with 敲门申请, one he already knocked on: 等开门),
 * - he-yu, who sits in more than 12 rooms (the 房间 table view, group tabs and the knock-chip strip),
 * - xiao-bai, a brand-new member with one agent and no rooms (empty states and the onboarding hero).
 * Everything is seeded in a fixed order, so the demo ids (and hashed colors) repeat run to run.
 */
import type { Hub } from '@agent-peers/hub'
import { type AgentSpec, type ConnectOptions, connectAgent, type DemoAgent } from './agents'

export interface DiscoverableRooms {
  /** zhang-wei's room: gulei can knock (敲门申请). */
  readonly apiReview: string
  /** li-na's `API 文档`: gulei already knocked (等开门 / 撤回). */
  readonly apiDocs: string
  /** zhou-min's `增长实验室`. */
  readonly growthLab: string
}

export interface ExtraCast {
  /** In 13 rooms: owns 8, joined 5, knocking on 2 more. */
  readonly crowd: DemoAgent
  /** Owns the rooms the crowd member joined, and knocks on two of the crowd member's rooms. */
  readonly host: DemoAgent
  /** A new member: one agent, no rooms. */
  readonly fresh: DemoAgent
}

export const CROWD_MEMBER = 'he-yu'
export const HOST_MEMBER = 'lin-feng'
export const FRESH_MEMBER = 'xiao-bai'

const CROWD_AGENT: AgentSpec = {
  key: 'docs',
  kind: 'claude-code',
  title: 'onboarding 文档整理',
  model: 'Opus 5.5',
  workspace: 'handbook',
}
const HOST_AGENT: AgentSpec = { key: 'infra', kind: 'codex', title: '基础设施巡检', model: 'GPT-5.1 Low' }
const FRESH_AGENT: AgentSpec = { key: 'first', kind: 'codex', title: '第一次用 Peers', model: 'GPT-5.1 Low' }

/** he-yu's own rooms; the first two are discoverable so lin-feng can knock on them. */
const CROWD_ROOMS = [
  'sdk-v3',
  'perf-budget',
  'search-infra',
  'ml-platform',
  'ios-release',
  'android-release',
  'data-warehouse',
  'oncall-rotation',
] as const
/** lin-feng's rooms that he-yu joins by invite. */
const HOST_ROOMS = ['k8s-upgrade', 'cost-review', 'log-pipeline', 'cdn-migration', 'sre-weekly'] as const

export interface ExtrasInput {
  readonly hub: Hub
  readonly url: string
  readonly connect?: ConnectOptions
  /** Rooms are created by these teammates' agents (zhang-wei, li-na, zhou-min). */
  readonly owners: { readonly zhangWei: DemoAgent; readonly liNa: DemoAgent; readonly zhouMin: DemoAgent }
}

async function connectNew(input: ExtrasInput, member: string, spec: AgentSpec): Promise<DemoAgent> {
  const { token } = input.hub.services.members.create(member)
  return connectAgent(input.url, token, member, spec, input.connect)
}

export async function seedDiscoverable(owners: ExtrasInput['owners']): Promise<DiscoverableRooms> {
  const apiReview = await owners.zhangWei.createRoom({
    name: 'api-review',
    handle: 'orders',
    description: '新接口先在这里过一遍：命名、分页、错误码',
  })
  const apiDocs = await owners.liNa.createRoom({
    name: 'api-docs',
    displayName: 'API 文档',
    handle: 'billing',
    description: '对外 API 文档的 agent，问字段含义和示例',
  })
  const growthLab = await owners.zhouMin.createRoom({
    name: 'growth-lab',
    displayName: '增长实验室',
    handle: 'growth',
  })
  return { apiReview: apiReview.roomId, apiDocs: apiDocs.roomId, growthLab: growthLab.roomId }
}

/** he-yu's 13 rooms (one at a time, so ids stay in a fixed order). */
async function seatCrowd(crowd: DemoAgent, host: DemoAgent): Promise<readonly string[]> {
  const owned: string[] = []
  for (const [i, name] of CROWD_ROOMS.entries()) {
    const room = await crowd.createRoom({ name, handle: `docs-${i + 1}`, discoverable: i < 2 })
    owned.push(room.roomId)
  }
  for (const [i, name] of HOST_ROOMS.entries()) {
    const room = await host.createRoom({ name, handle: `infra-${i + 1}`, discoverable: false })
    await crowd.joinByInvite(room.inviteCode, `docs-j${i + 1}`)
  }
  return owned
}

export interface SeededExtras {
  readonly cast: ExtraCast
  readonly rooms: DiscoverableRooms
  /** The pending knocks (gulei on API 文档, he-yu on two rooms, lin-feng on two of he-yu's). */
  knock(gulei: DemoAgent): Promise<void>
}

export async function seedExtras(input: ExtrasInput): Promise<SeededExtras> {
  const rooms = await seedDiscoverable(input.owners)
  const crowd = await connectNew(input, CROWD_MEMBER, CROWD_AGENT)
  const host = await connectNew(input, HOST_MEMBER, HOST_AGENT)
  const fresh = await connectNew(input, FRESH_MEMBER, FRESH_AGENT)
  const owned = await seatCrowd(crowd, host)
  return {
    cast: { crowd, host, fresh },
    rooms,
    async knock(gulei) {
      await gulei.handle.knock(rooms.apiDocs, '想让 agent 查查对外文档里退款接口的字段')
      await crowd.handle.knock(rooms.apiReview, '想把新人文档里的接口示例对一遍')
      await crowd.handle.knock(rooms.growthLab)
      for (const roomId of owned.slice(0, 2)) await host.handle.knock(roomId, '想问问 SDK 的发版节奏')
    },
  }
}
