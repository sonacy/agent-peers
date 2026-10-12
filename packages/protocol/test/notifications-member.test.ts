import { describe, expect, it } from 'bun:test'
import {
  AsksQuerySchema,
  CreateRoomBodySchema,
  DecideBodySchema,
  ErrorBodySchema,
  encodeMemberEvent,
  isMemberEventName,
  isNotificationName,
  isTerminalAskState,
  KnockBodySchema,
  MEMBER_EVENTS,
  MyRoomsResponseSchema,
  NOTIFICATION_NAMES,
  PatchSessionBodySchema,
  parseMemberEvent,
  parseNotification,
  RoomDetailResponseSchema,
} from '../src/index'
import { ask, card, invite, knock, message, RID, room, SID } from './fixtures'

const s = { session_id: SID }
const VALID: Record<string, unknown> = {
  'msg.new': { ...s, message, replay: true },
  'replay.done': { ...s, room_id: RID, head_seq: 1842 },
  'ask.updated': { ...s, ask_id: ask.ask_id, state: 'failed', reason: 'target_lost' },
  'presence.changed': { ...s, room_id: RID, handle: 'work', card },
  'handle.lost': { ...s, room_id: RID, handle: 'work', by: { member: 'gulei', session_id: SID } },
  'handle.renamed': { ...s, room_id: RID, old: 'work', new: 'job', by: 'admin' },
  'session.patched': { ...s, accepting: false, title: '新标题' },
  'knock.updated': { ...s, knock_id: 'K1', room_id: RID, state: 'accepted' },
  'room.removed': { ...s, room_id: RID, reason: 'dissolved' },
  'room.closed': { ...s, room_id: RID },
  kicked: { ...s, room_id: RID, reason: 'bye' },
}

describe('notifications', () => {
  it('parses every hub → bridge notification', () => {
    expect([...NOTIFICATION_NAMES].sort() as string[]).toEqual(Object.keys(VALID).sort())
    for (const [name, params] of Object.entries(VALID)) {
      const parsed = parseNotification(name, params)
      expect(parsed.ok).toBe(true)
    }
    const lost = parseNotification('handle.lost', VALID['handle.lost'])
    expect(lost.ok && 'ask_ids' in lost.params ? lost.params.ask_ids : null).toEqual([])
  })

  it('rejects malformed ones and flags unknown ones', () => {
    expect(parseNotification('room.removed', { ...s, room_id: RID, reason: 'bored' })).toMatchObject({
      ok: false,
      reason: 'invalid',
    })
    expect(
      parseNotification('knock.updated', { knock_id: 'K1', room_id: RID, state: 'pending' }),
    ).toMatchObject({
      ok: false,
      reason: 'invalid',
    })
    expect(parseNotification('future.thing', {})).toMatchObject({ ok: false, reason: 'unknown' })
    expect(isNotificationName('kicked')).toBe(true)
    expect(isNotificationName('constructor')).toBe(false)
  })

  it('knows terminal ask states', () => {
    expect(isTerminalAskState('answered')).toBe(true)
    expect(isTerminalAskState('working')).toBe(false)
  })
})

describe('member API', () => {
  it('validates request bodies', () => {
    expect(CreateRoomBodySchema.parse({ name: 'timely', display_name: '支付联调' })).toMatchObject({
      discoverable: true,
    })
    expect(CreateRoomBodySchema.safeParse({ name: '支付联调' }).success).toBe(false)
    expect(KnockBodySchema.parse({ note: 'a\nb' })).toEqual({ note: 'a b' })
    expect(DecideBodySchema.safeParse({ decision: 'accept' }).success).toBe(true)
    expect(PatchSessionBodySchema.safeParse({ accepting: false }).success).toBe(true)
    expect(PatchSessionBodySchema.safeParse({ room_id: RID }).success).toBe(false)
    expect(AsksQuerySchema.parse({})).toEqual({ filter: 'all' })
    expect(AsksQuerySchema.safeParse({ filter: 'others' }).success).toBe(false)
    expect(ErrorBodySchema.safeParse({ error: { code: 'forbidden', message: 'no' } }).success).toBe(true)
    expect(ErrorBodySchema.safeParse({ error: { code: 'nope', message: 'no' } }).success).toBe(false)
  })

  it('validates responses', () => {
    expect(
      MyRoomsResponseSchema.parse({
        rooms: [{ room, role: 'owner', people: 2, agents: 3, pending_knocks: 1, last_activity_at: null }],
      }).rooms[0]?.open_asks,
    ).toBe(0)
    const detail = RoomDetailResponseSchema.parse({
      room,
      my_role: 'owner',
      people: [
        {
          member_id: 'M1',
          member: 'gulei',
          role: 'owner',
          is_me: true,
          agents: [{ handle: 'work', card }],
          last_activity_at: 5,
        },
      ],
      invite,
      knocks: [knock],
      kicked: [{ member_id: 'M2', member: 'eve', kicked_at: 3 }],
    })
    expect(detail.people[0]?.agents[0]?.card.outdated).toBe(false)
  })

  it('encodes and parses SSE events', () => {
    const frame = encodeMemberEvent('ask', { ask }, '4\n2')
    expect(frame).toBe(`id: 42\nevent: ask\ndata: ${JSON.stringify({ ask })}\n\n`)
    expect(encodeMemberEvent('knock', { knock })).toStartWith('event: knock\n')
    expect(parseMemberEvent('ask', JSON.stringify({ ask }))?.ask.state).toBe('working')
    expect(parseMemberEvent('message', JSON.stringify({ message }))?.message.to).toEqual(['work'])
    expect(parseMemberEvent('room', JSON.stringify({ room_id: RID, change: 'dissolved' }))?.change).toBe(
      'dissolved',
    )
    expect(parseMemberEvent('session', '{bad')).toBeUndefined()
    expect(parseMemberEvent('presence', '{}')).toBeUndefined()
    expect(isMemberEventName('presence')).toBe(true)
    expect(isMemberEventName('hasOwnProperty')).toBe(false)
    expect(Object.keys(MEMBER_EVENTS).sort()).toEqual([
      'ask',
      'knock',
      'message',
      'presence',
      'room',
      'session',
    ])
  })
})
