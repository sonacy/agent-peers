/** Room fixtures (detail, people, knocks, search rows) and a stateful fake room for mutation tests. */
import type { SessionCard } from '@agent-peers/protocol'
import type { Invite, Knock, RoomAgent, RoomDetail, RoomPerson, SearchRoom } from '../../src/api/types'
import { memberHub } from './app'
import type { FakeHub, Handler } from './fake-hub'
import { card, NOW } from './fixtures'

export const ROOM_ID = 'r_timely'

export function agent(
  sessionId: string,
  overrides: Partial<SessionCard> = {},
  handle = sessionId,
): RoomAgent {
  return {
    handle: handle.replace(/[^a-z0-9_-]/g, '-'),
    card: card({ session_id: sessionId, title: sessionId, ...overrides }),
  }
}

export function person(
  memberId: string,
  member: string,
  agents: readonly RoomAgent[],
  overrides: Partial<RoomPerson> = {},
): RoomPerson {
  return {
    member_id: memberId,
    member,
    role: 'member',
    is_me: false,
    agents: [...agents],
    last_activity_at: NOW - 60_000,
    ...overrides,
  }
}

export function invite(overrides: Partial<Invite> = {}): Invite {
  return {
    room_id: ROOM_ID,
    state: 'active',
    code_masked: 'inv_••••••••7H58',
    role: 'member',
    created_at: NOW - 3_600_000,
    ...overrides,
  }
}

export const JOIN_PROMPT =
  'Join my agent-peers room "timely" so our coding agents can ask each other questions\n\ncurl -fsSL https://hub.example.com/install.sh | sh -s -- join https://hub.example.com/j/7K3QX9TZ4M2B7H58 --here'

export function knock(id: string, member: string, overrides: Partial<Knock> = {}): Knock {
  return {
    knock_id: id,
    room_id: ROOM_ID,
    member,
    member_id: `m_${member}`,
    note: null,
    state: 'pending',
    created_at: NOW - 600_000,
    expires_at: NOW + 86_400_000,
    ...overrides,
  }
}

export const ME_PERSON = person(
  'm_gulei',
  'gulei',
  [
    agent('s_sync', { title: '通用插件跨 agent session 同步', activity: 'busy' }, 'sync'),
    agent('s_t3', { title: '调研 T3Code 项目', agent: { kind: 'codex' } }, 't3'),
    agent('s_prd', { title: 'prd2demo', connection: 'offline' }, 'prd'),
  ],
  { role: 'owner', is_me: true },
)

export const ZHANG = person('m_zhang', 'zhangwei', [
  agent('s_pay', { title: '支付网关重构', member: 'zhangwei', agent: { kind: 'cursor' } }, 'pay'),
])

export const LINA = person('m_lina', 'lina', [
  agent('s_bill', { title: '账单服务排查', member: 'lina' }, 'bill'),
])

export function ownerDetail(overrides: Partial<RoomDetail> = {}): RoomDetail {
  return {
    room: { room_id: ROOM_ID, name: 'timely', owner: 'gulei', created_at: NOW - 5 * 86_400_000 },
    my_role: 'owner',
    people: [ME_PERSON, ZHANG, LINA],
    invite: invite(),
    join_prompt: JOIN_PROMPT,
    knocks: [
      knock('k_1', 'wangfang', { note: '想让我的 agent 问问 timely 里的接口规范' }),
      knock('k_2', 'zhoumin'),
    ],
    kicked: [],
    ...overrides,
  }
}

export function memberDetail(overrides: Partial<RoomDetail> = {}): RoomDetail {
  return {
    room: { room_id: ROOM_ID, name: 'timely', owner: 'zhangwei', created_at: NOW - 5 * 86_400_000 },
    my_role: 'member',
    people: [
      { ...ME_PERSON, role: 'member' },
      { ...ZHANG, role: 'owner' },
    ],
    ...overrides,
  }
}

/** `count` people with `agentsEach` agents, the first one me. */
export function bigPeople(count: number, agentsEach = 2): readonly RoomPerson[] {
  return Array.from({ length: count }, (_, i) =>
    person(
      `m_p${i}`,
      i === 0 ? 'gulei' : `person-${i}`,
      Array.from({ length: i === 0 ? 9 : agentsEach }, (_, j) =>
        agent(`s_${i}_${j}`, {
          title: `agent ${i}-${j}`,
          activity: j % 3 === 1 ? 'busy' : 'idle',
          connection: j % 3 === 2 ? 'offline' : 'online',
        }),
      ),
      { is_me: i === 0, role: i === 0 ? 'owner' : 'member' },
    ),
  )
}

export function searchRoom(id: string, name: string, overrides: Partial<SearchRoom> = {}): SearchRoom {
  return { room_id: id, name, owner: 'lina', member_count: 4, my_state: 'none', ...overrides }
}

export interface RoomHub {
  readonly hub: FakeHub
  /** The room as the hub currently has it; mutations update it. */
  readonly state: () => RoomDetail
  readonly set: (next: RoomDetail) => void
}

/** A fake hub whose room detail changes with the mutations, like the real one. */
export function roomHub(initial: RoomDetail, routes: Record<string, Handler> = {}): RoomHub {
  let detail = initial
  const id = initial.room.room_id
  const base = `/v0/me/rooms/${id}`
  const hub = memberHub({
    [`GET ${base}`]: () => detail,
    [`DELETE ${base}`]: { ok: true },
    [`POST ${base}/exit`]: { ok: true },
    'GET /v0/me/knocks': { knocks: [] },
    ...routes,
  })
  return { hub, state: () => detail, set: (next) => (detail = next) }
}
