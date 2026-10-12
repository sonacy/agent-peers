/**
 * 找房间 (DASHBOARD §4.2): debounced search over discoverable rooms, lime match highlighting, and
 * 敲门申请 → 等开门 → 撤回 on each row.
 */
import { type Ref, useState } from 'react'
import { friendlyError } from '../../../api/errors'
import { useRoomSearch } from '../../../api/queries'
import type { SearchRoom } from '../../../api/types'
import { ErrorBanner } from '../../error-banner'
import { SearchInput } from '../../ui/input'
import { CardSkeleton, DelayedSkeleton } from '../../ui/skeleton'
import { knockIdOn, useKnock, useMyKnocks, useWithdrawKnock } from '../data/use-knocks'
import { roomTitle } from '../model/rooms-model'
import { useDebounced } from '../use-debounced'
import { KnockDialog } from './knock-dialog'
import { SearchRow } from './search-row'

/** With an empty search box, suggest at most this many rooms I'm not in yet. */
export const SUGGESTIONS = 5

export interface FindRoomsProps {
  readonly inputRef?: Ref<HTMLInputElement>
  /** Many-rooms layout: only show results once something is typed. */
  readonly compact?: boolean
}

export function pickResults(rooms: readonly SearchRoom[], query: string): readonly SearchRoom[] {
  return query.trim() === '' ? rooms.filter((r) => r.my_state !== 'member').slice(0, SUGGESTIONS) : rooms
}

function Results({ query, rooms }: { readonly query: string; readonly rooms: readonly SearchRoom[] }) {
  const knocks = useMyKnocks(rooms.some((r) => r.my_state === 'knocking'))
  const knock = useKnock()
  const withdraw = useWithdrawKnock()
  const [knockOn, setKnockOn] = useState<SearchRoom | undefined>(undefined)
  if (rooms.length === 0) {
    return query.trim() === '' ? null : (
      <p className="rounded-2xl border-2 border-dashed border-muted/40 px-4 py-5 text-center text-muted text-sm">
        没找到「{query.trim()}」。房间可能没打开「能被找到」，直接找房主要一段邀请吧。
      </p>
    )
  }
  return (
    <>
      <ul aria-label="找到的房间" className="flex flex-col gap-3">
        {rooms.map((room) => (
          <SearchRow
            key={room.room_id}
            room={room}
            query={query}
            onKnock={setKnockOn}
            onWithdraw={(r) =>
              withdraw.mutate({
                roomId: r.room_id,
                roomName: roomTitle(r),
                knockId: knockIdOn(knocks.data, r.room_id),
              })
            }
          />
        ))}
      </ul>
      <KnockDialog
        room={knockOn}
        onOpenChange={(open) => {
          if (!open) setKnockOn(undefined)
        }}
        onKnock={(room, note) =>
          knock.mutate({
            roomId: room.room_id,
            roomName: roomTitle(room),
            ...(note === undefined ? {} : { note }),
          })
        }
      />
    </>
  )
}

export function FindRooms({ inputRef, compact = false }: FindRoomsProps) {
  const [query, setQuery] = useState('')
  const settled = useDebounced(query)
  const enabled = !compact || settled.trim() !== ''
  const search = useRoomSearch(settled.trim(), enabled)
  return (
    <section aria-labelledby="find-rooms-title" className="flex max-w-3xl flex-col gap-3">
      <h2 id="find-rooms-title" className="font-semibold text-muted text-sm">
        找房间
      </h2>
      <SearchInput
        ref={inputRef}
        label="找房间"
        value={query}
        onValueChange={setQuery}
        placeholder="房间名或房主，比如 api"
        className="max-w-xl"
      />
      {search.isError ? (
        <ErrorBanner
          title="房间没搜出来"
          description={friendlyError(search.error)}
          actionLabel="重试"
          onAction={() => void search.refetch()}
        />
      ) : null}
      <DelayedSkeleton loading={enabled && search.isPending} fallback={<CardSkeleton />} label="正在找房间…">
        {enabled && search.data !== undefined ? (
          <Results query={settled} rooms={pickResults(search.data, settled)} />
        ) : null}
      </DelayedSkeleton>
    </section>
  )
}
