/** Room detail states (DASHBOARD §5): dissolved, kicked, and a failed load. Each says what to do next. */
import { Link } from 'wouter'
import { friendlyError } from '../../../api/errors'
import { PATHS } from '../../../routes/paths'
import { EmptyState } from '../../empty-state'
import { ErrorBanner } from '../../error-banner'
import { RoomDoor } from '../../room-door'
import { Button } from '../../ui/button'

function BackToRooms() {
  return (
    <Button asChild size="sm" variant="primary">
      <Link href={PATHS.rooms}>回到房间列表</Link>
    </Button>
  )
}

export function RoomDissolved({ roomId }: { readonly roomId: string }) {
  return (
    <EmptyState
      art={<RoomDoor roomId={roomId} size={64} />}
      title="这个房间已经解散了"
      description="房主解散了它，里面的人和 agent 都出来了。聊过的问答还在问答页。"
    >
      <BackToRooms />
    </EmptyState>
  )
}

export function RoomKicked({ roomId, name }: { readonly roomId: string; readonly name: string | undefined }) {
  return (
    <EmptyState
      art={<RoomDoor roomId={roomId} size={64} />}
      title={name === undefined ? '你不在这个房间里' : `你已经被请出 ${name}`}
      description="想回来，找房主要一段新邀请，或者在「找房间」里敲门。"
    >
      <BackToRooms />
    </EmptyState>
  )
}

export function RoomLoadError({ error, onRetry }: { readonly error: unknown; readonly onRetry: () => void }) {
  return (
    <ErrorBanner
      title="房间没加载出来"
      description={friendlyError(error)}
      actionLabel="重试"
      onAction={onRetry}
    />
  )
}
