/**
 * The many-rooms table (DASHBOARD §4.2): group tabs, sort, the pinned knock strip and paging. Rows
 * are my rooms plus the rooms I'm knocking on (等开门), which come from my knocks and the room search.
 */
import type { Knock, MyRoom, SearchRoom, SessionCard } from '../../../api/types'

/** More rooms than this switch the list to a table (a toggle saves the choice). */
export const MANY_ROOMS = 12
export const FIRST_PAGE = 12
export const PAGE_STEP = 24

export const ROOM_GROUPS = ['all', 'owned', 'joined', 'knocking'] as const
export type RoomGroup = (typeof ROOM_GROUPS)[number]

export const GROUP_LABEL: Readonly<Record<RoomGroup, string>> = {
  all: '全部',
  owned: '我建的',
  joined: '我加入的',
  knocking: '等开门',
}

export const ROOM_SORTS = ['recent', 'people', 'name'] as const
export type RoomSort = (typeof ROOM_SORTS)[number]

export const SORT_LABEL: Readonly<Record<RoomSort, string>> = {
  recent: '最近活跃',
  people: '人数',
  name: '名字',
}

export type RoomRow =
  | { readonly kind: 'room'; readonly id: string; readonly room: MyRoom; readonly mine: number }
  | {
      readonly kind: 'knock'
      readonly id: string
      readonly knock: Knock
      /** Name, owner and size from the room search, when it has the room. */
      readonly info: SearchRoom | undefined
    }

export function roomTitle(room: { readonly name: string; readonly display_name?: string }): string {
  return room.display_name ?? room.name
}

/** How many of my agents sit in each room. */
export function myAgentCounts(sessions: readonly SessionCard[]): ReadonlyMap<string, number> {
  const counts = new Map<string, number>()
  for (const card of sessions) {
    for (const room of card.rooms) counts.set(room.room_id, (counts.get(room.room_id) ?? 0) + 1)
  }
  return counts
}

export function buildRows(
  rooms: readonly MyRoom[],
  knocks: readonly Knock[],
  search: readonly SearchRoom[],
  sessions: readonly SessionCard[],
): readonly RoomRow[] {
  const mine = myAgentCounts(sessions)
  const joined = new Set(rooms.map((r) => r.room.room_id))
  const roomRows = rooms.map(
    (room): RoomRow => ({
      kind: 'room',
      id: room.room.room_id,
      room,
      mine: mine.get(room.room.room_id) ?? 0,
    }),
  )
  const knockRows = knocks
    .filter((k) => k.state === 'pending' && !joined.has(k.room_id))
    .map(
      (knock): RoomRow => ({
        kind: 'knock',
        id: knock.room_id,
        knock,
        info: search.find((s) => s.room_id === knock.room_id),
      }),
    )
  return [...roomRows, ...knockRows]
}

export function inGroup(row: RoomRow, group: RoomGroup): boolean {
  if (group === 'all') return true
  if (row.kind === 'knock') return group === 'knocking'
  if (group === 'owned') return row.room.role === 'owner'
  return group === 'joined' && row.room.role !== 'owner'
}

export function groupCounts(rows: readonly RoomRow[]): Readonly<Record<RoomGroup, number>> {
  const count = (group: RoomGroup) => rows.filter((row) => inGroup(row, group)).length
  return { all: rows.length, owned: count('owned'), joined: count('joined'), knocking: count('knocking') }
}

export function rowName(row: RoomRow): string {
  if (row.kind === 'room') return roomTitle(row.room.room)
  return row.info === undefined ? '等开门的房间' : roomTitle(row.info)
}

function rowPeople(row: RoomRow): number {
  return row.kind === 'room' ? row.room.people : (row.info?.member_count ?? 0)
}

function rowActivity(row: RoomRow): number {
  return row.kind === 'room' ? (row.room.last_activity_at ?? 0) : row.knock.created_at
}

const COMPARE: Readonly<Record<RoomSort, (a: RoomRow, b: RoomRow) => number>> = {
  recent: (a, b) => rowActivity(b) - rowActivity(a),
  people: (a, b) => rowPeople(b) - rowPeople(a),
  name: (a, b) => rowName(a).localeCompare(rowName(b), 'zh-CN'),
}

/** Free-text filter on name, slug and owner (case-insensitive). */
export function matchesQuery(row: RoomRow, query: string): boolean {
  const q = query.trim().toLowerCase()
  if (q === '') return true
  const owner = row.kind === 'room' ? row.room.room.owner : row.info?.owner
  const slug = row.kind === 'room' ? row.room.room.name : row.info?.name
  return [rowName(row), slug ?? '', owner ?? ''].some((text) => text.toLowerCase().includes(q))
}

export function visibleRows(
  rows: readonly RoomRow[],
  group: RoomGroup,
  sort: RoomSort,
  query: string,
): readonly RoomRow[] {
  return rows.filter((row) => inGroup(row, group) && matchesQuery(row, query)).toSorted(COMPARE[sort])
}

/** Rooms I own with someone at the door, most knocks first (the pinned strip). */
export function knockingRooms(rooms: readonly MyRoom[]): readonly MyRoom[] {
  return rooms
    .filter((r) => r.role === 'owner' && (r.pending_knocks ?? 0) > 0)
    .toSorted((a, b) => (b.pending_knocks ?? 0) - (a.pending_knocks ?? 0))
}

/** 再看 24 个: the next page size, never more than what's left. */
export function nextStep(shown: number, total: number): number {
  return Math.max(0, Math.min(PAGE_STEP, total - shown))
}
