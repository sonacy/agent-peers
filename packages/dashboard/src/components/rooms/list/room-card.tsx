/** 我的房间 card (DASHBOARD §4.2): door, name, owner, role chip, agent stack and the knock badge. */
import { Hand } from 'lucide-react'
import { motion } from 'motion/react'
import { useId } from 'react'
import { Link } from 'wouter'
import type { MyRoom } from '../../../api/types'
import { formatCount } from '../../../lib/format/count'
import { entrance } from '../../../lib/motion'
import { PATHS } from '../../../routes/paths'
import { AvatarStack, type StackItem } from '../../avatar-stack'
import { RoomDoor } from '../../room-door'
import { Chip } from '../../ui/chip'
import { roomTitle } from '../model/rooms-model'
import { RoleChip } from '../role-chip'

export interface RoomCardProps {
  readonly room: MyRoom
  /** My agents in this room (real faces first in the stack). */
  readonly mine: readonly string[]
  readonly index: number
  readonly reduced: boolean
}

/** Up to 4 faces: my agents' real ids, then stand-ins seeded by the room so counts still read. */
export function stackItems(roomId: string, agents: number, mine: readonly string[]): readonly StackItem[] {
  const own = mine.slice(0, 4).map((id) => ({ id }))
  const fill = Array.from({ length: Math.max(0, Math.min(4, agents) - own.length) }, (_, i) => ({
    id: `${roomId}#${i}`,
  }))
  return [...own, ...fill]
}

export function KnockBadge({ count, id }: { readonly count: number; readonly id?: string }) {
  if (count <= 0) return null
  return (
    <Chip id={id} tone="blush" size="md" className="self-start">
      <Hand aria-hidden="true" />
      {formatCount(count)} 人在敲门
    </Chip>
  )
}

export function RoomCard({ room, mine, index, reduced }: RoomCardProps) {
  const name = roomTitle(room.room)
  const motionProps = entrance(index, reduced)
  const id = useId()
  const knocks = room.role === 'owner' ? (room.pending_knocks ?? 0) : 0
  // Named by the room; the owner, role, counts and pending knocks are its description, so screen
  // readers hear `{k} 人在敲门` without the name turning into a paragraph.
  const described = [`${id}-owner`, `${id}-role`, `${id}-meta`, ...(knocks > 0 ? [`${id}-knocks`] : [])]
  return (
    <motion.li {...motionProps} className="list-none">
      <Link
        href={PATHS.room(room.room.room_id)}
        aria-labelledby={`${id}-name`}
        aria-describedby={described.join(' ')}
        className="focus-ring press flex h-full flex-col gap-4 rounded-2xl border-2 border-line bg-surface p-4 shadow-hard hover:bg-surface-2/40"
      >
        <div className="flex items-start gap-3">
          <RoomDoor roomId={room.room.room_id} size={44} />
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span id={`${id}-name`} className="truncate font-display font-bold text-lg" title={name}>
              {name}
            </span>
            <span id={`${id}-owner`} className="truncate text-meta text-muted">
              房主 {room.room.owner ?? '—'}
            </span>
          </div>
          <RoleChip id={`${id}-role`} value={room.role} />
        </div>
        <div className="flex items-center gap-3">
          {room.agents > 0 ? (
            <AvatarStack
              items={stackItems(room.room.room_id, room.agents, mine)}
              total={room.agents}
              label={`${room.agents} 个 agent`}
            />
          ) : null}
          <span id={`${id}-meta`} className="font-semibold text-meta">
            {room.people} 人 · {room.agents} 个 agent
          </span>
        </div>
        <KnockBadge id={`${id}-knocks`} count={knocks} />
      </Link>
    </motion.li>
  )
}
