/**
 * 我的房间 (DASHBOARD §4.2): cards two across; past 12 rooms a table with group tabs, sort, the
 * pinned knock strip and paging (12, then 再看 24 个). The table/card choice is remembered.
 */
import { useMemo, useState } from 'react'
import { useRoomSearch, useSessions } from '../../../api/queries'
import type { MyRoom, SessionCard } from '../../../api/types'
import { PHONE_QUERY, useMediaQuery } from '../../../lib/hooks/use-media-query'
import { useMotionPreference } from '../../../lib/motion-preference'
import { readStored, writeStored } from '../../../lib/storage'
import { Button } from '../../ui/button'
import { knockIdOn, useMyKnocks, useWithdrawKnock } from '../data/use-knocks'
import {
  buildRows,
  FIRST_PAGE,
  groupCounts,
  MANY_ROOMS,
  nextStep,
  type RoomGroup,
  type RoomRow,
  type RoomSort,
  rowName,
  visibleRows,
} from '../model/rooms-model'
import { KnockStrip } from './knock-strip'
import { RoomCard } from './room-card'
import { RoomsList, RoomsTable } from './rooms-table'
import { RoomsToolbar, type RoomsView } from './rooms-toolbar'

export const ROOMS_VIEW_KEY = 'peers.rooms-view'

export function useRoomsView(): readonly [RoomsView, (view: RoomsView) => void] {
  const [view, setView] = useState<RoomsView>(() =>
    readStored(ROOMS_VIEW_KEY) === 'grid' ? 'grid' : 'table',
  )
  const save = (next: RoomsView) => {
    setView(next)
    writeStored(ROOMS_VIEW_KEY, next)
  }
  return [view, save]
}

function mineIn(sessions: readonly SessionCard[], roomId: string): readonly string[] {
  return sessions.filter((s) => s.rooms.some((r) => r.room_id === roomId)).map((s) => s.session_id)
}

export function RoomGrid({ rooms }: { readonly rooms: readonly MyRoom[] }) {
  const sessions = useSessions().data ?? []
  const { reduced } = useMotionPreference()
  return (
    <ul aria-label="我的房间" className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:max-w-4xl">
      {rooms.map((room, index) => (
        <RoomCard
          key={room.room.room_id}
          room={room}
          mine={mineIn(sessions, room.room.room_id)}
          index={index}
          reduced={reduced}
        />
      ))}
    </ul>
  )
}

function useRows(rooms: readonly MyRoom[]): readonly RoomRow[] {
  const sessions = useSessions().data
  const knocks = useMyKnocks().data
  const pending = (knocks ?? []).length > 0
  const search = useRoomSearch('', pending).data
  return useMemo(
    () => buildRows(rooms, knocks ?? [], search ?? [], sessions ?? []),
    [rooms, knocks, search, sessions],
  )
}

function Pager({
  shown,
  total,
  onMore,
}: {
  readonly shown: number
  readonly total: number
  readonly onMore: () => void
}) {
  const step = nextStep(shown, total)
  return (
    <div className="flex items-center justify-center gap-3 py-2 text-meta text-muted">
      <span>
        已显示 {shown} / {total}
      </span>
      {step > 0 ? (
        <Button size="sm" onClick={onMore}>
          再看 {step} 个
        </Button>
      ) : null}
    </div>
  )
}

export function ManyRooms({ rooms }: { readonly rooms: readonly MyRoom[] }) {
  const rows = useRows(rooms)
  const knocks = useMyKnocks().data
  const withdraw = useWithdrawKnock()
  const phone = useMediaQuery(PHONE_QUERY)
  const [view, setView] = useRoomsView()
  const [group, setGroup] = useState<RoomGroup>('all')
  const [sort, setSort] = useState<RoomSort>('recent')
  const [query, setQuery] = useState('')
  const [limit, setLimit] = useState(FIRST_PAGE)
  const visible = visibleRows(rows, group, sort, query)
  const page = visible.slice(0, limit)
  const reset =
    <T,>(set: (value: T) => void) =>
    (value: T) => {
      set(value)
      setLimit(FIRST_PAGE)
    }
  const onWithdraw = (row: Extract<RoomRow, { kind: 'knock' }>) =>
    withdraw.mutate({ roomId: row.id, roomName: rowName(row), knockId: knockIdOn(knocks, row.id) })
  const Table = phone ? RoomsList : RoomsTable
  const cards = page.flatMap((row) => (row.kind === 'room' ? [row.room] : []))
  return (
    <div className="flex flex-col gap-4">
      <KnockStrip rooms={rooms} />
      <RoomsToolbar
        {...{ query, sort, group, view }}
        counts={groupCounts(rows)}
        onQuery={reset(setQuery)}
        onGroup={reset(setGroup)}
        onSort={setSort}
        onView={setView}
      />
      {visible.length === 0 ? (
        <p className="rounded-2xl border-2 border-dashed border-muted/40 px-4 py-6 text-center text-muted text-sm">
          这一组里没有房间。换个分组或者清空搜索看看。
        </p>
      ) : view === 'table' ? (
        <Table rows={page} onWithdraw={onWithdraw} />
      ) : (
        <RoomGrid rooms={cards} />
      )}
      {visible.length > 0 ? (
        <Pager
          shown={page.length}
          total={visible.length}
          onMore={() => setLimit((n) => n + nextStep(n, visible.length))}
        />
      ) : null}
    </div>
  )
}

export function isMany(rooms: readonly MyRoom[]): boolean {
  return rooms.length > MANY_ROOMS
}
