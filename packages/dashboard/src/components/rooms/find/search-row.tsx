/** One 找房间 result: door, highlighted name and owner, and the knock state (DASHBOARD §4.2). */
import { Link } from 'wouter'
import type { SearchRoom } from '../../../api/types'
import { PATHS } from '../../../routes/paths'
import { RoomDoor } from '../../room-door'
import { Button } from '../../ui/button'
import { Chip } from '../../ui/chip'
import { Highlight } from '../highlight'
import { roomTitle } from '../model/rooms-model'

export interface SearchRowProps {
  readonly room: SearchRoom
  readonly query: string
  readonly onKnock: (room: SearchRoom) => void
  readonly onWithdraw: (room: SearchRoom) => void
}

function RowAction({ room, onKnock, onWithdraw }: Omit<SearchRowProps, 'query'>) {
  const name = roomTitle(room)
  if (room.my_state === 'member') {
    return (
      <Button asChild size="sm">
        <Link href={PATHS.room(room.room_id)} aria-label={`进 ${name} 看看`}>
          进去看看
        </Link>
      </Button>
    )
  }
  if (room.my_state === 'knocking') {
    return (
      <div className="flex items-center gap-2">
        <Chip tone="warn" size="md">
          等开门
        </Chip>
        <Button size="sm" onClick={() => onWithdraw(room)} aria-label={`撤回敲 ${name} 的门`}>
          撤回
        </Button>
      </div>
    )
  }
  return (
    <Button size="sm" variant="lime" onClick={() => onKnock(room)} aria-label={`敲门申请 ${name}`}>
      敲门申请
    </Button>
  )
}

export function SearchRow({ room, query, onKnock, onWithdraw }: SearchRowProps) {
  const name = roomTitle(room)
  return (
    <li
      aria-label={name}
      className="flex items-center gap-3 rounded-2xl border-2 border-line bg-surface p-3 shadow-btn sm:p-4"
    >
      <RoomDoor roomId={room.room_id} size={44} />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="truncate font-semibold text-card" title={name}>
          <Highlight text={name} query={query} />
        </span>
        <span className="truncate text-meta text-muted">
          房主 <Highlight text={room.owner} query={query} /> · {room.member_count} 人
        </span>
      </div>
      <RowAction room={room} onKnock={onKnock} onWithdraw={onWithdraw} />
    </li>
  )
}
