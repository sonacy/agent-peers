/** Member-API fixtures shaped like the hub's responses (protocol schemas fill the defaults). */
import type { SessionCard } from '@agent-peers/protocol'
import type { AskThread, Me, MyRoom } from '../../src/api/types'

export const NOW = Date.now()

export const ME: Me = { member_id: 'm_gulei', name: 'gulei', created_at: NOW - 86_400_000 }

export function card(overrides: Partial<SessionCard> = {}): SessionCard {
  return {
    session_id: 's_1',
    member: 'gulei',
    agent: { kind: 'claude-code' },
    model: 'Opus 5.5',
    host: 'mbp',
    title: '通用插件跨 agent session 同步',
    inject: 'push',
    connection: 'online',
    activity: 'idle',
    accepting: true,
    outdated: false,
    rooms: [{ room_id: 'r_timely', handle: 'sync' }],
    last_seen_at: NOW - 25_000,
    last_activity_at: NOW - 25_000,
    ...overrides,
  }
}

export function myRoom(
  overrides: Partial<MyRoom> & { readonly id?: string; readonly name?: string } = {},
): MyRoom {
  const { id = 'r_timely', name = 'timely', ...rest } = overrides
  return {
    room: { room_id: id, name, owner: 'gulei', created_at: NOW - 3_600_000 },
    role: 'owner',
    people: 2,
    agents: 1,
    open_asks: 0,
    pending_knocks: 0,
    last_activity_at: NOW - 60_000,
    ...rest,
  }
}

let seq = 0

export function thread(
  overrides: {
    readonly id?: string
    readonly state?: AskThread['ask']['state']
    readonly reason?: AskThread['ask']['reason']
    readonly question?: string
    readonly answer?: string | null
    readonly from?: SessionCard | null
    readonly to?: SessionCard | null
  } = {},
): AskThread {
  seq += 1
  const id = overrides.id ?? `a_${seq}`
  const state = overrides.state ?? 'answered'
  const answerText = overrides.answer === undefined ? '工作台本身不收费，模型费用自付。' : overrides.answer
  return {
    ask: {
      ask_id: id,
      room_id: 'r_timely',
      from_handle: 'sync',
      from_member: 'gulei',
      to_handle: 'research',
      state,
      expires_at: NOW + 86_400_000,
      ...(overrides.reason === undefined ? {} : { reason: overrides.reason }),
    },
    room: { room_id: 'r_timely', name: 'timely' },
    question: message(`${id}_q`, overrides.question ?? 'T3 Code 有多少用户？收费吗？', 'ask'),
    answer: answerText === null ? null : message(`${id}_r`, answerText, 'reply'),
    from: overrides.from === undefined ? card() : overrides.from,
    to:
      overrides.to === undefined
        ? card({ session_id: 's_2', member: 'zhangwei', title: 'Recent popular agent projects' })
        : overrides.to,
  }
}

function message(id: string, text: string, kind: 'ask' | 'reply') {
  return {
    id,
    room_id: 'r_timely',
    seq: 1,
    from: { handle: kind === 'ask' ? 'sync' : 'research', member: 'gulei' },
    kind,
    to: [],
    text,
    ts: NOW - 120_000,
  }
}
