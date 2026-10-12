import { describe, expect, it } from 'bun:test'
import {
  patchAskInPages,
  patchCard,
  patchSessionInList,
  removeRoomFromSession,
  replaceCardInRoom,
  replaceSession,
} from '../../src/api/cache'
import type { RoomDetail } from '../../src/api/types'
import { card, thread } from '../helpers/fixtures'

describe('session cache updaters', () => {
  const list = [card(), card({ session_id: 's_2', title: 'two' })]
  it('replaces a known card without touching the input', () => {
    const next = replaceSession(list, card({ title: 'renamed' }))
    expect(next?.[0]?.title).toBe('renamed')
    expect(list[0]?.title).toBe('通用插件跨 agent session 同步')
    expect(replaceSession(list, card({ session_id: 's_9' }))).toBeUndefined()
    expect(replaceSession(undefined, card())).toBeUndefined()
  })
  it('patches accepting, title and a handle in one room', () => {
    const base = card({
      rooms: [
        { room_id: 'r_1', handle: 'a' },
        { room_id: 'r_2', handle: 'b' },
      ],
    })
    const next = patchCard(base, { accepting: false, title: 'T', handle: 'c', room_id: 'r_2' })
    expect(next.accepting).toBe(false)
    expect(next.title).toBe('T')
    expect(next.rooms).toEqual([
      { room_id: 'r_1', handle: 'a' },
      { room_id: 'r_2', handle: 'c' },
    ])
    expect(patchCard(base, { handle: 'z' }).rooms).toBe(base.rooms)
    expect(patchCard(base, {})).toEqual(base)
    expect(patchSessionInList(list, 's_2', { accepting: false })?.[1]?.accepting).toBe(false)
    expect(patchSessionInList(undefined, 's_2', {})).toBeUndefined()
  })
  it('removes a room from one session', () => {
    expect(removeRoomFromSession(list, 's_1', 'r_timely')?.[0]?.rooms).toEqual([])
    expect(removeRoomFromSession(list, 's_1', 'r_timely')?.[1]).toBe(list[1])
  })
})

describe('room and ask updaters', () => {
  const detail: RoomDetail = {
    room: { room_id: 'r_timely', name: 'timely' },
    my_role: 'owner',
    people: [
      {
        member_id: 'm_1',
        member: 'gulei',
        role: 'owner',
        is_me: true,
        agents: [{ handle: 'sync', card: card() }],
        last_activity_at: null,
      },
    ],
  }
  it('replaces a card inside a room detail', () => {
    const next = replaceCardInRoom(detail, card({ activity: 'busy' }))
    expect(next?.people[0]?.agents[0]?.card.activity).toBe('busy')
    expect(replaceCardInRoom(detail, card({ session_id: 's_x' }))).toBeUndefined()
    expect(replaceCardInRoom(undefined, card())).toBeUndefined()
  })
  it('patches an ask record across pages', () => {
    const t = thread({ id: 'a_x', state: 'working', answer: null })
    const data = { pages: [{ asks: [t], next_cursor: null }], pageParams: [undefined] }
    const next = patchAskInPages(data, { ...t.ask, state: 'failed', reason: 'target_lost' })
    expect(next?.pages[0]?.asks[0]?.ask.state).toBe('failed')
    expect(patchAskInPages(data, { ...t.ask, ask_id: 'other' })).toBeUndefined()
    expect(patchAskInPages(undefined, t.ask)).toBeUndefined()
  })
})
