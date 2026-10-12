import { describe, expect, it } from 'bun:test'
import { QueryClient } from '@tanstack/react-query'
import type { AsksData } from '../../src/api/cache'
import { queryKeys } from '../../src/api/keys'
import type { RoomDetail, SessionCard } from '../../src/api/types'
import { ASKS_REFRESH_MS, applyMemberEvent } from '../../src/live/apply-event'
import { card, thread } from '../helpers/fixtures'

function client() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } })
}

function invalidated(qc: QueryClient, key: readonly unknown[]): boolean {
  return qc.getQueryState(key)?.isInvalidated === true
}

const detail = (c: SessionCard): RoomDetail => ({
  room: { room_id: 'r_timely', name: 'timely' },
  my_role: 'member',
  people: [
    {
      member_id: 'm',
      member: 'gulei',
      role: 'member',
      is_me: true,
      agents: [{ handle: 'sync', card: c }],
      last_activity_at: null,
    },
  ],
})

const base = { id: 'msg', room_id: 'r', seq: 1, to: [], text: 'hi', ts: 1 }

describe('applyMemberEvent', () => {
  it('session: patches my list and every cached room detail', () => {
    const qc = client()
    qc.setQueryData(queryKeys.sessions, [card()])
    qc.setQueryData(queryKeys.room('r_timely'), detail(card()))
    applyMemberEvent(qc, { name: 'session', data: { session: card({ title: '改好了' }) } })
    expect(qc.getQueryData<SessionCard[]>(queryKeys.sessions)?.[0]?.title).toBe('改好了')
    expect(qc.getQueryData<RoomDetail>(queryKeys.room('r_timely'))?.people[0]?.agents[0]?.card.title).toBe(
      '改好了',
    )
    expect(invalidated(qc, queryKeys.sessions)).toBe(false)
  })
  it('session: unknown cards refetch my list', () => {
    const qc = client()
    qc.setQueryData(queryKeys.sessions, [card()])
    applyMemberEvent(qc, { name: 'session', data: { session: card({ session_id: 's_new' }) } })
    expect(invalidated(qc, queryKeys.sessions)).toBe(true)
  })
  it('presence: patches the card, or refetches that room when the agent is new to it', () => {
    const qc = client()
    qc.setQueryData(queryKeys.sessions, [card()])
    qc.setQueryData(queryKeys.room('r_timely'), detail(card()))
    qc.setQueryData(queryKeys.room('r_other'), {
      ...detail(card({ session_id: 's_x' })),
      room: { room_id: 'r_other', name: 'o' },
    })
    applyMemberEvent(qc, {
      name: 'presence',
      data: { room_id: 'r_timely', handle: 'sync', card: card({ activity: 'busy' }) },
    })
    expect(qc.getQueryData<SessionCard[]>(queryKeys.sessions)?.[0]?.activity).toBe('busy')
    applyMemberEvent(qc, {
      name: 'presence',
      data: { room_id: 'r_other', handle: 'n', card: card({ session_id: 's_n' }) },
    })
    expect(invalidated(qc, queryKeys.room('r_other'))).toBe(true)
    expect(invalidated(qc, queryKeys.room('r_timely'))).toBe(false)
  })
  it('room and knock: refetch rooms, that room and search; membership changes refetch sessions', () => {
    const qc = client()
    for (const key of [
      queryKeys.rooms,
      queryKeys.room('r_1'),
      queryKeys.roomSearch('a'),
      queryKeys.sessions,
    ]) {
      qc.setQueryData(key, { stub: true })
    }
    applyMemberEvent(qc, { name: 'room', data: { room_id: 'r_1', change: 'updated' } })
    expect(invalidated(qc, queryKeys.rooms)).toBe(true)
    expect(invalidated(qc, queryKeys.room('r_1'))).toBe(true)
    expect(invalidated(qc, queryKeys.roomSearch('a'))).toBe(true)
    expect(invalidated(qc, queryKeys.sessions)).toBe(false)
    applyMemberEvent(qc, { name: 'room', data: { room_id: 'r_1', change: 'members' } })
    expect(invalidated(qc, queryKeys.sessions)).toBe(true)
    const qc2 = client()
    qc2.setQueryData(queryKeys.rooms, [])
    qc2.setQueryData(queryKeys.room('r_1'), {})
    applyMemberEvent(qc2, {
      name: 'knock',
      data: {
        knock: {
          knock_id: 'k',
          room_id: 'r_1',
          member: 'li',
          state: 'pending',
          created_at: 1,
          expires_at: 2,
        },
      },
    })
    expect(invalidated(qc2, queryKeys.rooms)).toBe(true)
    expect(invalidated(qc2, queryKeys.room('r_1'))).toBe(true)
  })
  it('ask: patches loaded threads in place; answers without text and unknown asks refetch the feed', async () => {
    const qc = client()
    const t = thread({ id: 'a_live', state: 'delivered', answer: null })
    const data: AsksData = { pages: [{ asks: [t], next_cursor: null }], pageParams: [undefined] }
    qc.setQueryData(queryKeys.asks('all'), data)
    applyMemberEvent(qc, { name: 'ask', data: { ask: { ...t.ask, state: 'working' } } })
    expect(qc.getQueryData<AsksData>(queryKeys.asks('all'))?.pages[0]?.asks[0]?.ask.state).toBe('working')
    await Bun.sleep(ASKS_REFRESH_MS + 30)
    expect(invalidated(qc, queryKeys.asks('all'))).toBe(false)
    applyMemberEvent(qc, { name: 'ask', data: { ask: { ...t.ask, state: 'answered' } } })
    expect(invalidated(qc, queryKeys.asks('all'))).toBe(false)
    await Bun.sleep(ASKS_REFRESH_MS + 30)
    expect(invalidated(qc, queryKeys.asks('all'))).toBe(true)
    const qc2 = client()
    qc2.setQueryData(queryKeys.asks('mine'), data)
    applyMemberEvent(qc2, { name: 'ask', data: { ask: { ...t.ask, ask_id: 'a_new' } } })
    await Bun.sleep(ASKS_REFRESH_MS + 30)
    expect(invalidated(qc2, queryKeys.asks('mine'))).toBe(true)
  })
  it('message: a reply fills its thread in place, so the answered ask needs no refetch', async () => {
    const qc = client()
    const t = thread({ id: 'a_live', state: 'working', answer: null })
    qc.setQueryData<AsksData>(queryKeys.asks('all'), {
      pages: [{ asks: [t], next_cursor: null }],
      pageParams: [undefined],
    })
    const reply = { ...base, id: 'msg_r', kind: 'reply' as const, re: 'a_live', text: '答案' }
    applyMemberEvent(qc, { name: 'message', data: { message: reply } })
    applyMemberEvent(qc, { name: 'ask', data: { ask: { ...t.ask, state: 'answered' } } })
    const patched = qc.getQueryData<AsksData>(queryKeys.asks('all'))?.pages[0]?.asks[0]
    expect(patched?.answer?.text).toBe('答案')
    expect(patched?.ask.state).toBe('answered')
    await Bun.sleep(ASKS_REFRESH_MS + 30)
    expect(invalidated(qc, queryKeys.asks('all'))).toBe(false)
  })
  it('message: new asks and unknown replies refetch once per burst, chat does not', async () => {
    const qc = client()
    qc.setQueryData(queryKeys.asks('all'), { pages: [], pageParams: [] })
    applyMemberEvent(qc, { name: 'message', data: { message: { ...base, kind: 'chat' } } })
    await Bun.sleep(ASKS_REFRESH_MS + 30)
    expect(invalidated(qc, queryKeys.asks('all'))).toBe(false)
    let refetches = 0
    const off = qc.getQueryCache().subscribe((event) => {
      if (event.type === 'updated' && event.action.type === 'invalidate') refetches += 1
    })
    applyMemberEvent(qc, { name: 'message', data: { message: { ...base, kind: 'ask' } } })
    applyMemberEvent(qc, { name: 'message', data: { message: { ...base, kind: 'reply', re: 'a_x' } } })
    await Bun.sleep(ASKS_REFRESH_MS + 30)
    off()
    expect(invalidated(qc, queryKeys.asks('all'))).toBe(true)
    expect(refetches).toBe(1)
  })
  it('trims feeds nobody is watching to their first page before they refetch', async () => {
    const qc = client()
    const page = (id: string) => ({ asks: [thread({ id })], next_cursor: 'next' })
    qc.setQueryData<AsksData>(queryKeys.asks('to_me'), {
      pages: [page('a_1'), page('a_2'), page('a_3')],
      pageParams: [undefined, 'p2', 'p3'],
    })
    applyMemberEvent(qc, { name: 'message', data: { message: { ...base, kind: 'ask' } } })
    await Bun.sleep(ASKS_REFRESH_MS + 30)
    const trimmed = qc.getQueryData<AsksData>(queryKeys.asks('to_me'))
    expect(trimmed?.pages).toHaveLength(1)
    expect(trimmed?.pageParams).toEqual([undefined])
  })
})
