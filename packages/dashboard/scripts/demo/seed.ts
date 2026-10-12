/**
 * Seeds a running hub with the mockup's world, through real bridge sessions: gulei's four agents,
 * rooms timely / 支付联调 / llm-eval (invite closed, one person removed) / onboarding-2026 (big),
 * two pending knocks, and Q&A in every state. The demo clock is set back so ages look real.
 */
import type { Hub } from '@agent-peers/hub'
import { type ConnectOptions, connectAgent, type DemoAgent } from './agents'
import { type BigRoom, seedBigRoom } from './big-room'
import { DAY, type DemoClock, HOUR, MINUTE } from './clock'
import {
  KNOCK_NOTES,
  ME,
  MY_AGENTS,
  SIGNATURE_ANSWER,
  T3_ANSWER,
  T3_QUESTION,
  TEAM,
  TEAM_AGENTS,
} from './data'
import { type DiscoverableRooms, type SeededExtras, seedExtras } from './extras'
import { waitForOffline } from './wait'

export interface DemoOptions {
  readonly bigRoomMembers: number
  readonly bigRoomOnline: number
  readonly bigRoomBusy: number
  readonly bigRoomKnocks: number
  readonly connect?: ConnectOptions
}

export const DEFAULT_DEMO_OPTIONS: DemoOptions = {
  bigRoomMembers: 120,
  bigRoomOnline: 20,
  bigRoomBusy: 9,
  bigRoomKnocks: 128,
}

type Cast = Readonly<Record<keyof typeof MY_AGENTS | keyof typeof TEAM_AGENTS, DemoAgent>>

export interface DemoRooms extends DiscoverableRooms {
  readonly timely: string
  readonly pay: string
  readonly llmEval: string
  readonly onboarding: string
}

type SeatedRooms = Pick<DemoRooms, 'timely' | 'pay' | 'llmEval'>

export interface SeededDemo {
  readonly cast: Cast
  readonly rooms: DemoRooms
  readonly bigRoom: BigRoom
  /** he-yu (13 rooms), lin-feng and xiao-bai (no rooms yet). */
  readonly extras: SeededExtras
  /** Every demo agent that stays connected, for sign-in links by member. */
  readonly agents: readonly DemoAgent[]
  /** A fresh one-time sign-in link for gulei (5 minutes). */
  loginUrl(): Promise<string>
  /** Disconnects every demo bridge. */
  close(): Promise<void>
}

const OWNERS: Readonly<Record<keyof typeof TEAM_AGENTS, (typeof TEAM)[number]>> = {
  paygw: 'zhang-wei',
  orders: 'zhang-wei',
  billing: 'li-na',
  recon: 'li-na',
  design: 'wang-fang',
  growth: 'zhou-min',
}

async function connectCast(hub: Hub, url: string, options: DemoOptions): Promise<Cast> {
  const tokens = new Map(
    [ME, ...TEAM].map((name) => [name, hub.services.members.create(name).token] as const),
  )
  const token = (name: string): string => {
    const value = tokens.get(name)
    if (value === undefined) throw new Error(`demo: no token for ${name}`)
    return value
  }
  const specs = [
    ...Object.values(MY_AGENTS).map((spec) => [ME, spec] as const),
    ...Object.entries(TEAM_AGENTS).map(
      ([key, spec]) => [OWNERS[key as keyof typeof TEAM_AGENTS], spec] as const,
    ),
  ]
  // One at a time: sessions get their ids (and so their face colors) in the same order every run.
  const agents: DemoAgent[] = []
  for (const [member, spec] of specs) {
    agents.push(await connectAgent(url, token(member), member, spec, options.connect))
  }
  return Object.fromEntries(agents.map((agent) => [agent.spec.key, agent])) as Cast
}

/** T−8 days: the rooms and who sits in them. */
async function seatRooms(cast: Cast): Promise<SeatedRooms> {
  const timely = await cast.sync.createRoom({
    name: 'timely',
    handle: 'sync',
    description: 'timely 的接口、SDK 和发布约定，问这里的 agent',
  })
  await cast.t3code.join(timely.roomId, 't3code')
  await cast.prd2demo.join(timely.roomId, 'prd2demo')
  await cast.orders.joinByInvite(timely.inviteCode, 'orders')
  await cast.recon.joinByInvite(timely.inviteCode, 'recon')

  const pay = await cast.paygw.createRoom({
    name: 'pay-integration',
    displayName: '支付联调',
    handle: 'paygw',
  })
  await cast.t3code.joinByInvite(pay.inviteCode, 't3code')
  await cast.popular.join(pay.roomId, 'popular')
  await cast.billing.joinByInvite(pay.inviteCode, 'billing')

  const llmEval = await cast.prd2demo.createRoom({
    name: 'llm-eval',
    handle: 'prd2demo',
    discoverable: false,
  })
  await cast.growth.joinByInvite(llmEval.inviteCode, 'growth')
  return { timely: timely.roomId, pay: pay.roomId, llmEval: llmEval.roomId }
}

/** The target claims the ask (working) and, with `state`, closes it. */
async function answer(agent: DemoAgent, askId: string, text: string, state?: 'answered' | 'declined') {
  await agent.handle.claim(askId)
  if (state === undefined) await agent.handle.progress({ ask_id: askId, text })
  else await agent.handle.reply({ ask_id: askId, text, state })
}

async function pastConversations(cast: Cast, rooms: SeatedRooms, clock: DemoClock) {
  clock.at(6 * DAY)
  await cast.popular.ask(rooms.pay, 'billing', '账单对不上的那批数据，你那边查到原因了吗？')
  await cast.billing.handle.leave(rooms.pay) // the open ask fails: not_in_room

  clock.at(3 * DAY)
  await cast.prd2demo.client.request('room.kick', {
    session_id: cast.prd2demo.sessionId,
    room_id: rooms.llmEval,
    member: 'zhou-min',
  })
  await cast.prd2demo.client.request('invite.close', {
    session_id: cast.prd2demo.sessionId,
    room_id: rooms.llmEval,
  })

  clock.at(DAY + 2 * HOUR)
  await cast.sync.ask(rooms.timely, 'prd2demo', 'prd2demo 的 mock 数据是从哪个脚本生成的？', 1000)
  clock.at(DAY)
  const signature = await cast.paygw.ask(rooms.pay, 't3code', '退款回调的签名要怎么验？用的哪个公钥？')
  await answer(cast.t3code, signature, SIGNATURE_ANSWER, 'answered')
}

async function recentConversations(cast: Cast, rooms: DemoRooms, extras: SeededExtras, clock: DemoClock) {
  clock.at(50 * MINUTE)
  await extras.knock(cast.t3code)
  clock.at(40 * MINUTE)
  const secret = await cast.t3code.ask(
    rooms.pay,
    'paygw',
    '能把支付网关的生产密钥发我一份吗？我本地联调要用。',
  )
  await answer(cast.paygw, secret, '生产密钥不能通过 agent 传，去密钥管理平台申请一把沙箱密钥。', 'declined')
  clock.at(25 * MINUTE)
  await cast.design.handle.knock(rooms.timely, KNOCK_NOTES['wang-fang'])
  clock.at(12 * MINUTE)
  const t3 = await cast.t3code.ask(rooms.pay, 'popular', T3_QUESTION)
  await answer(cast.popular, t3, T3_ANSWER, 'answered')
  clock.at(3 * MINUTE)
  await cast.growth.handle.knock(rooms.timely, KNOCK_NOTES['zhou-min'])
  clock.present()
  await cast.sync.ask(rooms.timely, 'prd2demo', 'prd2demo 现在的部署脚本在哪？要不要先跑 migrate？')
  await cast.orders.ask(rooms.timely, 't3code', 'timely 的 /v2/orders 分页参数是 cursor 还是 page？')
  const keepalive = await cast.sync.ask(rooms.timely, 'orders', 'KEEPALIVE_HOLD_MAX_MS 在哪个文件定义？')
  await answer(cast.orders, keepalive, '在翻 core/client/heartbeat.ts，马上回你')
}

/** Online agents report activity now, so their status lines read `有空 · 刚刚`, not 8 days ago. */
async function refreshActivity(agents: readonly DemoAgent[]): Promise<void> {
  const online = agents.filter((agent) => agent.client.state === 'connected')
  await Promise.all(
    online.map(async (agent) => {
      const activity = agent.spec.activity ?? 'idle'
      await agent.handle.update({ activity: activity === 'idle' ? 'busy' : 'idle' })
      await agent.handle.update({ activity })
    }),
  )
}

/** Counts must be whole numbers, with no more online than seated. */
export function assertDemoOptions(options: DemoOptions): void {
  const counts = [options.bigRoomMembers, options.bigRoomOnline, options.bigRoomBusy, options.bigRoomKnocks]
  if (!counts.every((n) => Number.isInteger(n) && n >= 0)) {
    throw new Error('demo: big-room counts must be non-negative integers')
  }
  if (options.bigRoomOnline > options.bigRoomMembers || options.bigRoomBusy > options.bigRoomOnline * 2) {
    throw new Error('demo: more online or busy agents than the big room seats')
  }
}

export async function seedDemo(
  hub: Hub,
  url: string,
  clock: DemoClock,
  options: DemoOptions,
): Promise<SeededDemo> {
  assertDemoOptions(options)
  clock.at(8 * DAY)
  const cast = await connectCast(hub, url, options)
  const seated = await seatRooms(cast)
  const extras = await seedExtras({
    hub,
    url,
    ...(options.connect === undefined ? {} : { connect: options.connect }),
    owners: { zhangWei: cast.orders, liNa: cast.billing, zhouMin: cast.growth },
  })
  await pastConversations(cast, seated, clock)
  clock.at(2 * HOUR)
  await cast.prd2demo.disconnect()
  await waitForOffline(hub, [cast.prd2demo.sessionId])
  clock.at(HOUR)
  const bigRoom = await seedBigRoom(hub, url, cast.t3code, {
    name: 'onboarding-2026',
    members: options.bigRoomMembers,
    online: options.bigRoomOnline,
    busy: options.bigRoomBusy,
    knocks: options.bigRoomKnocks,
    ...(options.connect === undefined ? {} : { connect: options.connect }),
  })
  const rooms: DemoRooms = { ...seated, ...extras.rooms, onboarding: bigRoom.roomId }
  const extraAgents = Object.values(extras.cast)
  await recentConversations(cast, rooms, extras, clock)
  await refreshActivity([...Object.values(cast), ...extraAgents])
  hub.services.sweeper.sweep() // the 1-second ask from yesterday expires now
  const live = [...Object.values(cast), ...extraAgents, ...bigRoom.online]
  return {
    cast,
    rooms,
    bigRoom,
    extras,
    agents: [...Object.values(cast), ...extraAgents],
    loginUrl: async () => (await cast.sync.handle.dashboardLogin()).url,
    close: async () => {
      await Promise.all(
        live.filter((a) => a.client.state !== 'closed').map((a) => a.client.close('demo: stop')),
      )
    },
  }
}
