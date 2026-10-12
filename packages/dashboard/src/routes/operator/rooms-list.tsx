/**
 * All rooms on the hub (DASHBOARD §10), read-only except 解散. A table from 640px up; on phones each
 * row becomes a two-line item so the page never scrolls sideways (§9).
 */
import { useState } from 'react'
import { EmptyState } from '../../components/empty-state'
import { ErrorBanner } from '../../components/error-banner'
import { RelativeTime } from '../../components/relative-time'
import { RoomDoor } from '../../components/room-door'
import { Badge } from '../../components/ui/badge'
import { Button } from '../../components/ui/button'
import { Card } from '../../components/ui/card'
import { SearchInput } from '../../components/ui/input'
import { CardSkeleton, DelayedSkeleton } from '../../components/ui/skeleton'
import { useToast } from '../../components/ui/toast'
import { cn } from '../../lib/cn'
import { useAdminRooms, useDissolveRoom } from './admin-queries'
import type { AdminRoom } from './admin-schemas'
import { ConfirmDialog } from './confirm-dialog'
import { adminErrorText } from './format'
import { PagingFooter, usePaged } from './list-paging'
import { matchRoom, roomLabel } from './logic'

/** Phone: two lines (room + action, then the numbers). From 640px: one table row. */
const ROW_GRID =
  'grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 sm:grid-cols-[minmax(0,1fr)_3rem_3.5rem_3rem_3.5rem_6rem_4.5rem]'
const STAT = 'tabular-nums sm:text-sm sm:text-ink'

function HeaderRow() {
  return (
    <div aria-hidden="true" className={cn(ROW_GRID, 'hidden px-4 py-2 text-meta text-muted sm:grid')}>
      <span>房间</span>
      <span>人数</span>
      <span>agent</span>
      <span>待答</span>
      <span>敲门</span>
      <span>最近活跃</span>
      <span className="text-right">操作</span>
    </div>
  )
}

function RoomName({ room }: { readonly room: AdminRoom['room'] }) {
  const label = roomLabel(room)
  const meta = [`房主 ${room.owner ?? '—'}`, ...(label === room.name ? [] : [room.name])].join(' · ')
  return (
    <div className="flex min-w-0 items-center gap-2.5">
      <RoomDoor roomId={room.room_id} size={28} />
      <div className="flex min-w-0 flex-col">
        <span className="truncate font-semibold text-sm" title={label}>
          {label}
        </span>
        <span className="truncate text-meta text-muted" title={meta}>
          {meta}
        </span>
      </div>
    </div>
  )
}

function RoomRow({ row, onDissolve }: { readonly row: AdminRoom; readonly onDissolve: () => void }) {
  const label = roomLabel(row.room)
  return (
    <li className={`group border-surface-2 border-t-2 px-4 py-3 max-sm:first:border-t-0 ${ROW_GRID}`}>
      <RoomName room={row.room} />
      <div className="col-start-1 row-start-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-meta text-muted sm:contents">
        <span className={STAT}>
          {row.people}
          <span className="sm:hidden"> 人</span>
        </span>
        <span className={STAT}>
          {row.agents}
          <span className="sm:hidden"> 个 agent</span>
        </span>
        <span className={STAT}>
          {row.open_asks}
          <span className="sm:hidden"> 个待答</span>
        </span>
        <span>
          {row.pending_knocks > 0 ? (
            <Badge tone="blush" count={row.pending_knocks} label={`${row.pending_knocks} 人在敲门`} />
          ) : (
            <span className="max-sm:hidden">—</span>
          )}
        </span>
        <span>
          {row.last_activity_at === null ? '还没人说话' : <RelativeTime ts={row.last_activity_at} />}
        </span>
      </div>
      <div className="col-start-2 row-span-2 row-start-1 text-right sm:col-start-auto sm:row-span-1 sm:row-start-auto">
        <Button size="sm" variant="danger-ghost" onClick={onDissolve} aria-label={`解散 ${label}`}>
          解散
        </Button>
      </div>
    </li>
  )
}

function DissolveDialog({
  room,
  onClose,
}: {
  readonly room: AdminRoom | undefined
  readonly onClose: () => void
}) {
  const dissolve = useDissolveRoom()
  const { toast } = useToast()
  const name = room?.room.name ?? ''
  const confirm = () => {
    if (room === undefined) return
    dissolve.mutate(room.room.room_id, {
      onSuccess: () => {
        toast({ title: `已解散 ${roomLabel(room.room)}`, tone: 'success' })
        onClose()
      },
    })
  }
  return (
    <ConfirmDialog
      open={room !== undefined}
      onOpenChange={(open) => {
        if (!open) {
          dissolve.reset()
          onClose()
        }
      }}
      title={`解散 ${room === undefined ? '' : roomLabel(room.room)}？`}
      description="房间里所有 agent 会被移出，没答完的问题都会失败，邀请全部失效。解散后不能恢复。"
      actionLabel="解散房间"
      confirmText={name}
      pending={dissolve.isPending}
      error={dissolve.isError ? adminErrorText(dissolve.error) : undefined}
      onConfirm={confirm}
    />
  )
}

export function RoomsTable({ rooms }: { readonly rooms: readonly AdminRoom[] }) {
  const paged = usePaged(rooms, matchRoom)
  const [target, setTarget] = useState<AdminRoom | undefined>(undefined)
  return (
    <div className="flex flex-col gap-3">
      <SearchInput
        label="找房间"
        placeholder="房间名或房主"
        value={paged.query}
        onValueChange={paged.setQuery}
      />
      {paged.matched === 0 ? (
        <EmptyState
          art={<RoomDoor roomId="no-rooms" size={44} />}
          title={rooms.length === 0 ? '还没有房间' : '没找到匹配的房间'}
          description={
            rooms.length === 0 ? '成员在 agent 里说 /peers:room new 名字 就会建一个。' : '换个关键词试试。'
          }
        />
      ) : (
        <Card className="overflow-hidden">
          <HeaderRow />
          <ul aria-label="所有房间">
            {paged.visible.map((row) => (
              <RoomRow key={row.room.room_id} row={row} onDissolve={() => setTarget(row)} />
            ))}
          </ul>
        </Card>
      )}
      {paged.matched > 0 ? (
        <PagingFooter shown={paged.visible.length} total={paged.matched} onMore={paged.showMore} />
      ) : null}
      <DissolveDialog room={target} onClose={() => setTarget(undefined)} />
    </div>
  )
}

export function RoomsSection() {
  const rooms = useAdminRooms()
  return (
    <section aria-labelledby="rooms-title" className="flex flex-col gap-3">
      <h2 id="rooms-title" className="font-display font-bold text-section">
        所有房间 {rooms.data === undefined ? null : <span className="text-muted">{rooms.data.length}</span>}
      </h2>
      {rooms.isError ? (
        <ErrorBanner
          title="读不到房间列表"
          description={adminErrorText(rooms.error)}
          actionLabel="再试一次"
          onAction={() => void rooms.refetch()}
        />
      ) : rooms.data === undefined ? (
        <DelayedSkeleton loading fallback={<CardSkeleton />} />
      ) : (
        <RoomsTable rooms={rooms.data} />
      )}
    </section>
  )
}
