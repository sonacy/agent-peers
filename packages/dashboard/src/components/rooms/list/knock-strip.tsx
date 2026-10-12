/** 等你开门: rooms with pending knocks, pinned above the table as a scrolling chip strip (§4.2). */
import { Hand } from 'lucide-react'
import { Link } from 'wouter'
import type { MyRoom } from '../../../api/types'
import { PATHS } from '../../../routes/paths'
import { Badge } from '../../ui/badge'
import { knockingRooms, roomTitle } from '../model/rooms-model'

export function KnockStrip({ rooms }: { readonly rooms: readonly MyRoom[] }) {
  const pinned = knockingRooms(rooms)
  if (pinned.length === 0) return null
  return (
    <section aria-labelledby="knock-strip-title" className="flex flex-col gap-2">
      <h2 id="knock-strip-title" className="flex items-center gap-1.5 font-semibold text-meta">
        <Hand aria-hidden="true" className="size-3.5 text-danger" />
        等你开门
      </h2>
      <ul className="scrollbar-none -mx-4 flex gap-2 overflow-x-auto px-4 py-1 sm:mx-0 sm:px-0">
        {pinned.map((room) => {
          const name = roomTitle(room.room)
          const count = room.pending_knocks ?? 0
          return (
            <li key={room.room.room_id} className="shrink-0">
              <Link
                href={PATHS.room(room.room.room_id)}
                className="focus-ring press inline-flex min-h-11 max-w-60 items-center gap-2 rounded-full border-2 border-line bg-surface px-4 font-semibold text-sm shadow-btn"
              >
                <span className="truncate" title={name}>
                  {name}
                </span>
                <Badge count={count} tone="blush" label={`${count} 人在敲门`} />
              </Link>
            </li>
          )
        })}
      </ul>
    </section>
  )
}
