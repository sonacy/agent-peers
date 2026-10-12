/**
 * Pure updaters for the room screens' caches (room detail, my rooms, room search, my knocks). Each
 * returns a new value and never mutates its input; optimistic mutations apply them, then refetch.
 */
import type { Invite, Knock, MyRoom, RoomDetail, SearchRoom } from '../../../api/types'

type People = RoomDetail['people']

function mapPeople(detail: RoomDetail, update: (people: People) => People): RoomDetail {
  return { ...detail, people: update(detail.people) }
}

/** ⇥ 移出房间: the agent leaves; the person (and their grant) stays. */
export function withoutAgent(detail: RoomDetail, sessionId: string): RoomDetail {
  return mapPeople(detail, (people) =>
    people.map((person) =>
      person.agents.some((a) => a.card.session_id === sessionId)
        ? { ...person, agents: person.agents.filter((a) => a.card.session_id !== sessionId) }
        : person,
    ),
  )
}

/** 请出房间: the person leaves and shows up under 被请出的人. */
export function withKicked(detail: RoomDetail, memberId: string, now: number): RoomDetail {
  const person = detail.people.find((p) => p.member_id === memberId)
  if (person === undefined) return detail
  const kicked = [
    { member_id: person.member_id, member: person.member, kicked_at: now },
    ...(detail.kicked ?? []).filter((k) => k.member_id !== memberId),
  ]
  return { ...detail, people: detail.people.filter((p) => p.member_id !== memberId), kicked }
}

/** 恢复: off the kicked list (they come back as a person on the next fetch). */
export function withoutKicked(detail: RoomDetail, memberId: string): RoomDetail {
  return { ...detail, kicked: (detail.kicked ?? []).filter((k) => k.member_id !== memberId) }
}

/** 开门 / 先不了: the knock leaves the pending list. */
export function withoutKnocks(detail: RoomDetail, knockIds: ReadonlySet<string>): RoomDetail {
  return { ...detail, knocks: (detail.knocks ?? []).filter((k) => !knockIds.has(k.knock_id)) }
}

export function withInvite(
  detail: RoomDetail,
  invite: Invite | null,
  joinPrompt: string | null | undefined,
): RoomDetail {
  return { ...detail, invite, join_prompt: joinPrompt ?? null }
}

/** 关闭邀请: closed at once; the prompt is no longer valid. */
export function withInviteClosed(detail: RoomDetail): RoomDetail {
  const invite = detail.invite
  return {
    ...detail,
    invite: invite === null || invite === undefined ? invite : { ...invite, state: 'closed' },
    join_prompt: null,
  }
}

export function isInviteOpen(detail: RoomDetail): boolean {
  return detail.invite !== null && detail.invite !== undefined && detail.invite.state === 'active'
}

// ---- my rooms -----------------------------------------------------------------------------------

export function withoutRoom(
  rooms: readonly MyRoom[] | undefined,
  roomId: string,
): readonly MyRoom[] | undefined {
  return rooms?.filter((r) => r.room.room_id !== roomId)
}

/** Lowers a room's pending-knock badge after deciding `count` knocks. */
export function withFewerKnocks(
  rooms: readonly MyRoom[] | undefined,
  roomId: string,
  count: number,
): readonly MyRoom[] | undefined {
  return rooms?.map((r) =>
    r.room.room_id === roomId && r.pending_knocks !== undefined
      ? { ...r, pending_knocks: Math.max(0, r.pending_knocks - count) }
      : r,
  )
}

// ---- search and my knocks -------------------------------------------------------------------------

export function withSearchState(
  rooms: readonly SearchRoom[] | undefined,
  roomId: string,
  state: SearchRoom['my_state'],
): readonly SearchRoom[] | undefined {
  return rooms?.map((r) => (r.room_id === roomId ? { ...r, my_state: state } : r))
}

export function withKnock(knocks: readonly Knock[] | undefined, knock: Knock): readonly Knock[] {
  return [knock, ...(knocks ?? []).filter((k) => k.room_id !== knock.room_id)]
}

export function withoutRoomKnock(
  knocks: readonly Knock[] | undefined,
  roomId: string,
): readonly Knock[] | undefined {
  return knocks?.filter((k) => k.room_id !== roomId)
}
