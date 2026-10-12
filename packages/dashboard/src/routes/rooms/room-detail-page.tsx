/**
 * Room detail (`/app/rooms/:id`, DASHBOARD §4.3) and its states (§5): loading, dissolved, kicked and
 * a failed load. `?invite=1` (straight after 新建房间) focuses the invite panel.
 */
import { useQueryClient } from '@tanstack/react-query'
import { useLocation, useSearch } from 'wouter'
import { isForbidden, isNotFound } from '../../api/errors'
import { queryKeys } from '../../api/keys'
import { useRoom } from '../../api/queries'
import type { MyRoom } from '../../api/types'
import { RoomDissolved, RoomKicked, RoomLoadError } from '../../components/rooms/detail/room-states'
import { RoomView } from '../../components/rooms/detail/room-view'
import { roomTitle } from '../../components/rooms/model/rooms-model'
import { CardSkeleton, DelayedSkeleton, Skeleton } from '../../components/ui/skeleton'
import { PHONE_QUERY, useMediaQuery } from '../../lib/hooks/use-media-query'
import { PATHS } from '../paths'

/** The room's name from whatever we last knew: its detail, or my rooms list. */
function useKnownName(roomId: string, fromDetail: string | undefined): string | undefined {
  const client = useQueryClient()
  if (fromDetail !== undefined) return fromDetail
  const listed = client
    .getQueryData<readonly MyRoom[]>(queryKeys.rooms)
    ?.find((r) => r.room.room_id === roomId)
  return listed === undefined ? undefined : roomTitle(listed.room)
}

function DetailSkeleton() {
  return (
    <div className="flex flex-col gap-6">
      <Skeleton className="h-36 rounded-2xl" />
      <CardSkeleton className="h-28" />
      <CardSkeleton className="h-28" />
    </div>
  )
}

export default function RoomDetailPage({ params }: { readonly params: { readonly id: string } }) {
  const roomId = params.id
  const room = useRoom(roomId)
  const phone = useMediaQuery(PHONE_QUERY)
  const [, navigate] = useLocation()
  const focusInvite = new URLSearchParams(useSearch()).has('invite')
  const name = useKnownName(roomId, room.data === undefined ? undefined : roomTitle(room.data.room))
  if (room.isError && isNotFound(room.error)) return <RoomDissolved roomId={roomId} />
  if (room.isError && isForbidden(room.error)) return <RoomKicked roomId={roomId} name={name} />
  if (room.data === undefined) {
    return room.isError ? (
      <RoomLoadError error={room.error} onRetry={() => void room.refetch()} />
    ) : (
      <DelayedSkeleton loading fallback={<DetailSkeleton />} label="正在打开房间…" />
    )
  }
  return (
    <RoomView
      detail={room.data}
      phone={phone}
      focusInvite={focusInvite}
      onGone={() => navigate(PATHS.rooms)}
    />
  )
}
