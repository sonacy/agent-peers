import '../helpers/dom'
import { describe, expect, it } from 'bun:test'
import { copyText } from '../../src/components/rooms/copy'
import { createInput, draftSlug } from '../../src/components/rooms/create-room-dialog'
import {
  isInviteOpen,
  withFewerKnocks,
  withInvite,
  withInviteClosed,
  withKicked,
  withKnock,
  withoutAgent,
  withoutKicked,
  withoutKnocks,
  withoutRoom,
  withoutRoomKnock,
  withSearchState,
} from '../../src/components/rooms/data/room-cache'
import { seedDetail } from '../../src/components/rooms/data/use-room-lifecycle'
import { pickResults } from '../../src/components/rooms/find/find-rooms'
import { splitHighlight } from '../../src/components/rooms/highlight'
import { stackItems } from '../../src/components/rooms/list/room-card'
import {
  agentTitle,
  applyPeopleQuery,
  canManagePerson,
  isBigRoom,
  NO_QUERY,
  ownerName,
} from '../../src/components/rooms/model/people-model'
import {
  buildRows,
  knockingRooms,
  nextStep,
  roomTitle,
  rowName,
} from '../../src/components/rooms/model/rooms-model'
import { invitePreview } from '../../src/components/rooms/side/invite-panel'
import { installDom } from '../helpers/dom'
import { ME, myRoom } from '../helpers/fixtures'
import { agent, bigPeople, invite, knock, ownerDetail, person, searchRoom } from '../helpers/room-fixtures'

installDom()

describe('room cache updaters', () => {
  const detail = ownerDetail()

  it('removes one agent or all of a person, never mutating', () => {
    const next = withoutAgent(detail, 's_pay')
    expect(next.people.find((p) => p.member_id === 'm_zhang')?.agents).toHaveLength(0)
    expect(detail.people.find((p) => p.member_id === 'm_zhang')?.agents).toHaveLength(1)
    expect(withoutAgent(detail, 'nope').people).toEqual(detail.people)
  })

  it('kicks into the kicked list and restores out of it', () => {
    const kicked = withKicked(detail, 'm_lina', 42)
    expect(kicked.people.map((p) => p.member)).toEqual(['gulei', 'zhangwei'])
    expect(kicked.kicked).toEqual([{ member_id: 'm_lina', member: 'lina', kicked_at: 42 }])
    expect(withKicked(detail, 'nobody', 1)).toBe(detail)
    expect(withoutKicked(kicked, 'm_lina').kicked).toEqual([])
    expect(withoutKicked({ ...detail, kicked: undefined }, 'x').kicked).toEqual([])
  })

  it('drops decided knocks and updates the invite', () => {
    expect(withoutKnocks(detail, new Set(['k_1'])).knocks?.map((k) => k.knock_id)).toEqual(['k_2'])
    expect(withoutKnocks({ ...detail, knocks: undefined }, new Set()).knocks).toEqual([])
    const closed = withInviteClosed(detail)
    expect(closed.invite?.state).toBe('closed')
    expect(closed.join_prompt).toBeNull()
    expect(isInviteOpen(closed)).toBe(false)
    expect(isInviteOpen(detail)).toBe(true)
    expect(withInviteClosed({ ...detail, invite: null }).invite).toBeNull()
    expect(withInvite(detail, null, undefined)).toMatchObject({ invite: null, join_prompt: null })
  })

  it('patches my rooms, the search and my knocks', () => {
    const rooms = [
      myRoom({ pending_knocks: 3 }),
      myRoom({ id: 'r_b', role: 'member', pending_knocks: undefined }),
    ]
    expect(withoutRoom(rooms, 'r_timely')?.map((r) => r.room.room_id)).toEqual(['r_b'])
    expect(withoutRoom(undefined, 'x')).toBeUndefined()
    expect(withFewerKnocks(rooms, 'r_timely', 5)?.[0]?.pending_knocks).toBe(0)
    expect(withFewerKnocks(rooms, 'r_b', 1)?.[1]?.pending_knocks).toBeUndefined()
    const search = [searchRoom('r_a', 'a'), searchRoom('r_b', 'b')]
    expect(withSearchState(search, 'r_b', 'knocking')?.map((r) => r.my_state)).toEqual(['none', 'knocking'])
    const k = knock('k_9', 'gulei', { room_id: 'r_a' })
    expect(withKnock(undefined, k)).toEqual([k])
    expect(withKnock([knock('k_old', 'gulei', { room_id: 'r_a' })], k)).toEqual([k])
    expect(withoutRoomKnock([k], 'r_a')).toEqual([])
  })
})

describe('rooms model', () => {
  it('builds rows from my rooms and pending knocks on rooms I am not in', () => {
    const rows = buildRows(
      [myRoom()],
      [
        knock('k_1', 'gulei', { room_id: 'r_x' }),
        knock('k_2', 'gulei', { room_id: 'r_timely' }),
        knock('k_3', 'gulei', { room_id: 'r_y', state: 'declined' }),
      ],
      [searchRoom('r_x', 'x-room', { display_name: '某房间' })],
      [],
    )
    expect(rows.map((r) => r.kind)).toEqual(['room', 'knock'])
    expect(rows.map(rowName)).toEqual(['timely', '某房间'])
  })

  it('pins rooms with knocks, most first, and steps pages', () => {
    const pinned = knockingRooms([
      myRoom({ id: 'a', pending_knocks: 1 }),
      myRoom({ id: 'b', pending_knocks: 9 }),
      myRoom({ id: 'c', role: 'member', pending_knocks: 4 }),
      myRoom({ id: 'd', pending_knocks: 0 }),
    ])
    expect(pinned.map((r) => r.room.room_id)).toEqual(['b', 'a'])
    expect(nextStep(12, 100)).toBe(24)
    expect(nextStep(12, 15)).toBe(3)
    expect(nextStep(15, 15)).toBe(0)
    expect(roomTitle({ name: 'x', display_name: '名' })).toBe('名')
  })
})

describe('people model', () => {
  const detail = ownerDetail()

  it('filters by status, mine and search, keeping name hits', () => {
    const busy = applyPeopleQuery(detail.people, { ...NO_QUERY, filter: 'busy' })
    expect(busy.map((p) => p.member)).toEqual(['gulei'])
    expect(busy[0]?.agents.map((a) => a.card.session_id)).toEqual(['s_sync'])
    expect(applyPeopleQuery(detail.people, { ...NO_QUERY, mineOnly: true }).map((p) => p.member)).toEqual([
      'gulei',
    ])
    const byName = applyPeopleQuery(detail.people, { ...NO_QUERY, search: 'LINA' })
    expect(byName.map((p) => p.member)).toEqual(['lina'])
    expect(byName[0]?.agents).toHaveLength(1)
    const empty = person('m_e', 'empty', [])
    expect(applyPeopleQuery([empty], { ...NO_QUERY, search: 'empty' })).toHaveLength(1)
    expect(applyPeopleQuery([empty], { ...NO_QUERY, search: 'empty', filter: 'idle' })).toHaveLength(0)
    expect(applyPeopleQuery([empty], NO_QUERY)).toHaveLength(1)
    expect(applyPeopleQuery(detail.people, { ...NO_QUERY, search: 'sync' })[0]?.agents).toHaveLength(1)
  })

  it('knows big rooms, owners and who can be managed', () => {
    expect(isBigRoom(detail)).toBe(false)
    expect(isBigRoom({ ...detail, people: [...bigPeople(11)] })).toBe(true)
    expect(ownerName({ ...detail, room: { ...detail.room, owner: undefined } })).toBe('gulei')
    expect(ownerName({ ...detail, room: { ...detail.room, owner: undefined }, people: [] })).toBe('房主')
    const [me, zhang] = detail.people
    expect(me !== undefined && canManagePerson(detail, me)).toBe(false)
    expect(zhang !== undefined && canManagePerson(detail, zhang)).toBe(true)
    expect(zhang !== undefined && canManagePerson({ ...detail, my_role: 'member' }, zhang)).toBe(false)
    expect(agentTitle(agent('s_x', { title: '  ', host: 'mbp' }))).toBe('Claude Code · mbp')
  })
})

describe('find, create and invite helpers', () => {
  it('highlights every case-insensitive match', () => {
    expect(splitHighlight('API-api', 'api')).toEqual([
      { text: 'API', hit: true },
      { text: '-', hit: false },
      { text: 'api', hit: true },
    ])
    expect(splitHighlight('timely', '  ')).toEqual([{ text: 'timely', hit: false }])
    expect(splitHighlight('timely', 'zzz')).toEqual([{ text: 'timely', hit: false }])
  })

  it('suggests a few rooms when the box is empty', () => {
    const rooms = Array.from({ length: 8 }, (_, i) =>
      searchRoom(`r_${i}`, `r${i}`, { my_state: i === 0 ? 'member' : 'none' }),
    )
    expect(pickResults(rooms, '')).toHaveLength(5)
    expect(pickResults(rooms, '')[0]?.room_id).toBe('r_1')
    expect(pickResults(rooms, 'r')).toHaveLength(8)
  })

  it('derives slugs and the create body', () => {
    expect(draftSlug('Payments Team', undefined)).toBe('payments-team')
    expect(draftSlug('  ', undefined)).toBe('')
    expect(draftSlug('支付联调', 'custom')).toBe('custom')
    expect(draftSlug('支付联调', undefined)).toMatch(/^room-[a-z0-9]+$/)
    expect(createInput({ name: 'api', slug: 'api', description: '  ', discoverable: true })).toEqual({
      name: 'api',
      discoverable: true,
    })
  })

  it('previews the invite without the real code', () => {
    const [line, code] = invitePreview('timely', invite())
    expect(line).toBe('[peers invite] Join the Peers room "timely" …')
    expect(line.match(/…/g)).toHaveLength(1)
    expect(code).toBe('Code: inv_••••••••7H58')
    expect(`${line}${code}`).not.toContain('7K3QX9TZ4M2B7H58')
  })

  it('stacks my agents first, then stand-ins', () => {
    expect(stackItems('r', 6, ['s_a']).map((i) => i.id)).toEqual(['s_a', 'r#0', 'r#1', 'r#2'])
    expect(stackItems('r', 0, [])).toEqual([])
  })

  it('seeds a new room as its owner sees it', () => {
    const created = {
      room: { room_id: 'r_n', name: 'n' },
      invite: invite(),
      invite_url: 'u',
      join_prompt: 'p',
    }
    expect(seedDetail(created, ME).people[0]).toMatchObject({ member: 'gulei', is_me: true, role: 'owner' })
    expect(seedDetail(created, undefined).people).toEqual([])
  })

  it('reports clipboard failures instead of throwing', async () => {
    const original = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
    Object.defineProperty(globalThis, 'navigator', { value: {}, configurable: true })
    expect(await copyText('x')).toBe(false)
    Object.defineProperty(globalThis, 'navigator', {
      value: { clipboard: { writeText: async () => {} } },
      configurable: true,
    })
    expect(await copyText('x')).toBe(true)
    if (original !== undefined) Object.defineProperty(globalThis, 'navigator', original)
  })
})
