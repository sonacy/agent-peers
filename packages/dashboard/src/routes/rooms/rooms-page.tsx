/**
 * 房间 (`/app/rooms`, DASHBOARD §4.2): 找房间, 我的房间 (cards, or a table past 12 rooms) and 新建房间.
 * `?new=1` opens the create dialog and `?find=1` focuses the search box (from 我的 agent's buttons).
 */
import { Plus } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useLocation, useSearch } from 'wouter'
import { friendlyError } from '../../api/errors'
import { useMyRooms } from '../../api/queries'
import type { MyRoom } from '../../api/types'
import { NoRoomsEmpty } from '../../components/empty-state'
import { ErrorBanner } from '../../components/error-banner'
import { PageHeader, SectionHeader } from '../../components/page-header'
import { CreateRoomDialog } from '../../components/rooms/create-room-dialog'
import { FindRooms } from '../../components/rooms/find/find-rooms'
import { isMany, ManyRooms, RoomGrid } from '../../components/rooms/list/my-rooms'
import { Button } from '../../components/ui/button'
import { CardSkeleton, DelayedSkeleton } from '../../components/ui/skeleton'
import { PATHS } from '../paths'

export const ROOMS_SUBTITLE =
  'agent 们串门的地方。同一个房间里的 agent 才能互相提问，房间外的人看不到里面有谁。'

/** Where a new room opens: its page with the invite panel focused. */
export function createdRoomHref(roomId: string): string {
  return `${PATHS.room(roomId)}?invite=1`
}

function Title({ rooms }: { readonly rooms: readonly MyRoom[] | undefined }) {
  if (rooms === undefined || !isMany(rooms)) return <>房间</>
  return (
    <>
      房间 <span className="font-sans font-semibold text-muted text-section">共 {rooms.length} 个</span>
    </>
  )
}

function MyRoomsSection({
  onCreate,
  onFind,
}: {
  readonly onCreate: () => void
  readonly onFind: () => void
}) {
  const rooms = useMyRooms()
  const list = rooms.data
  return (
    <section aria-labelledby="my-rooms-title" className="flex flex-col gap-4">
      <SectionHeader title="我的房间" id="my-rooms-title" />
      {rooms.isError && list === undefined ? (
        <ErrorBanner
          title="没拿到你的房间列表"
          description={friendlyError(rooms.error)}
          actionLabel="重试"
          onAction={() => void rooms.refetch()}
        />
      ) : null}
      <DelayedSkeleton
        loading={rooms.isPending}
        label="正在加载房间…"
        fallback={
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:max-w-4xl">
            <CardSkeleton className="h-36" />
            <CardSkeleton className="h-36" />
          </div>
        }
      >
        {list === undefined ? null : list.length === 0 ? (
          <NoRoomsEmpty onCreate={onCreate} onFind={onFind} className="lg:max-w-4xl" />
        ) : isMany(list) ? (
          <ManyRooms rooms={list} />
        ) : (
          <RoomGrid rooms={list} />
        )}
      </DelayedSkeleton>
    </section>
  )
}

export default function RoomsPage() {
  const params = new URLSearchParams(useSearch())
  const [, navigate] = useLocation()
  const [creating, setCreating] = useState(false)
  const search = useRef<HTMLInputElement>(null)
  const rooms = useMyRooms().data
  const wantsFind = params.has('find')
  const wantsNew = params.has('new')
  useEffect(() => {
    if (wantsFind) search.current?.focus()
  }, [wantsFind])
  useEffect(() => {
    if (wantsNew) setCreating(true)
  }, [wantsNew])
  const setOpen = (open: boolean) => {
    setCreating(open)
    if (!open && wantsNew) navigate(PATHS.rooms, { replace: true })
  }
  return (
    <div className="flex flex-col gap-8">
      <PageHeader
        title={<Title rooms={rooms} />}
        subtitle={ROOMS_SUBTITLE}
        actions={
          <Button variant="primary" onClick={() => setCreating(true)}>
            <Plus aria-hidden="true" />
            新建房间
          </Button>
        }
      />
      <FindRooms inputRef={search} compact={rooms !== undefined && isMany(rooms)} />
      <MyRoomsSection onCreate={() => setCreating(true)} onFind={() => search.current?.focus()} />
      <CreateRoomDialog
        open={creating}
        onOpenChange={setOpen}
        onCreated={(roomId) => navigate(createdRoomHref(roomId))}
      />
    </div>
  )
}
