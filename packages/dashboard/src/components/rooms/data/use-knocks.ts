/**
 * My side of knocking (DASHBOARD §4.2): 敲门申请 and 撤回. The search row flips to 等开门 at once and
 * flips back with a toast if the hub refuses. `myKnocks` holds the ids that 撤回 needs.
 */
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useApi } from '../../../api/context'
import { isApiError } from '../../../api/errors'
import { queryKeys } from '../../../api/keys'
import { shouldRetry } from '../../../api/queries'
import type { Knock, SearchRoom } from '../../../api/types'
import { patchAll, patchOf, useOptimistic } from './optimistic'
import { withKnock, withoutRoomKnock, withSearchState } from './room-cache'

export function useMyKnocks(enabled = true) {
  const api = useApi()
  return useQuery({
    queryKey: queryKeys.myKnocks,
    queryFn: () => api.myKnocks(),
    enabled,
    retry: shouldRetry,
  })
}

type SearchRooms = readonly SearchRoom[]

export interface KnockVars {
  readonly roomId: string
  readonly roomName: string
  readonly note?: string
}

export function useKnock() {
  const api = useApi()
  const client = useQueryClient()
  return useOptimistic({
    mutationFn: async ({ roomId, note }: KnockVars) => {
      try {
        return (await api.knock(roomId, note)).knock
      } catch (error) {
        // Already knocking is the state we wanted: keep 等开门 and refetch the id.
        if (isApiError(error) && error.code === 'knock_pending') return undefined
        throw error
      }
    },
    patches: ({ roomId }, c) =>
      patchAll<SearchRooms>(
        c,
        queryKeys.roomSearchAll,
        (rooms) => withSearchState(rooms, roomId, 'knocking') ?? rooms,
      ),
    refetch: () => [queryKeys.myKnocks, queryKeys.roomSearchAll],
    errorTitle: '门没敲成',
    successToast: (_knock, { roomName }) => `敲过 ${roomName} 的门了，等房主开门`,
    onSuccess: (knock: Knock | undefined) => {
      if (knock === undefined) return
      client.setQueryData<readonly Knock[]>(queryKeys.myKnocks, (list) => withKnock(list, knock))
    },
  })
}

export interface WithdrawVars extends KnockVars {
  /** From my knocks when loaded; otherwise looked up from the hub first. */
  readonly knockId?: string
}

async function pendingKnockId(roomId: string, load: () => Promise<readonly Knock[]>): Promise<string> {
  const knock = (await load()).find((k) => k.room_id === roomId && k.state === 'pending')
  if (knock === undefined) throw new Error('no pending knock on this room')
  return knock.knock_id
}

export function useWithdrawKnock() {
  const api = useApi()
  return useOptimistic({
    mutationFn: async ({ roomId, knockId }: WithdrawVars) => {
      await api.withdrawKnock(knockId ?? (await pendingKnockId(roomId, () => api.myKnocks())))
    },
    patches: ({ roomId }, c) => [
      ...patchAll<SearchRooms>(
        c,
        queryKeys.roomSearchAll,
        (rooms) => withSearchState(rooms, roomId, 'none') ?? rooms,
      ),
      patchOf<readonly Knock[]>(queryKeys.myKnocks, (knocks) => withoutRoomKnock(knocks, roomId) ?? knocks),
    ],
    refetch: () => [queryKeys.myKnocks, queryKeys.roomSearchAll],
    errorTitle: '没撤回',
    successToast: (_r, { roomName }) => `撤回了敲 ${roomName} 的门`,
  })
}

/** My pending knock id on a room, if my knocks are loaded. */
export function knockIdOn(knocks: readonly Knock[] | undefined, roomId: string): string | undefined {
  return knocks?.find((k) => k.room_id === roomId && k.state === 'pending')?.knock_id
}
