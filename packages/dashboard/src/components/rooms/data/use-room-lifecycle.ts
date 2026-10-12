/**
 * Creating, leaving and dissolving rooms (DASHBOARD §4.2, §4.3). Leaving and dissolving drop the room
 * from my list at once (rolled back with a toast on failure); the caller navigates away on success.
 */
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useApi } from '../../../api/context'
import { queryKeys } from '../../../api/keys'
import type { CreatedRoom, CreateRoomInput, Me, MyRoom, RoomDetail } from '../../../api/types'
import { useToast } from '../../ui/toast'
import { patchOf, useOptimistic } from './optimistic'
import { withoutRoom } from './room-cache'

/** The new room as its owner will see it, until the real detail arrives. */
export function seedDetail(created: CreatedRoom, me: Me | undefined): RoomDetail {
  const people =
    me === undefined
      ? []
      : [
          {
            member_id: me.member_id,
            member: me.name,
            role: 'owner' as const,
            is_me: true,
            agents: [],
            last_activity_at: null,
          },
        ]
  return {
    room: created.room,
    my_role: 'owner',
    people,
    invite: created.invite,
    join_prompt: created.join_prompt,
    knocks: [],
    kicked: [],
  }
}

/** 新建房间: seeds the new room's detail so its page opens with the invite already there. */
export function useCreateRoom() {
  const api = useApi()
  const client = useQueryClient()
  const { toast } = useToast()
  return useMutation({
    mutationFn: (input: CreateRoomInput) => api.createRoom(input),
    onSuccess: async (created: CreatedRoom) => {
      const seed = seedDetail(created, client.getQueryData<Me>(queryKeys.me))
      // Stale on purpose (updatedAt 0): the room page shows it at once and still refetches.
      client.setQueryData(queryKeys.room(created.room.room_id), seed, { updatedAt: 0 })
      toast({ title: `建好了：${created.room.display_name ?? created.room.name}`, tone: 'success' })
      await client.invalidateQueries({ queryKey: queryKeys.rooms })
    },
  })
}

export interface RoomRef {
  readonly roomId: string
  readonly name: string
}

function useLeaveLike(
  run: (roomId: string) => Promise<void>,
  copy: { readonly error: string; readonly done: (name: string) => string },
  onDone: () => void,
) {
  const client = useQueryClient()
  return useOptimistic({
    mutationFn: ({ roomId }: RoomRef) => run(roomId),
    patches: ({ roomId }) => [
      patchOf<readonly MyRoom[]>(queryKeys.rooms, (rooms) => withoutRoom(rooms, roomId) ?? rooms),
    ],
    refetch: () => [queryKeys.rooms, queryKeys.sessions, queryKeys.roomSearchAll],
    errorTitle: copy.error,
    successToast: (_r, { name }) => copy.done(name),
    onSuccess: (_r, { roomId }) => {
      onDone()
      client.removeQueries({ queryKey: queryKeys.room(roomId), exact: true })
    },
  })
}

/** 退出房间 (members): my grant and my agents leave the room. */
export function useExitRoom(onDone: () => void) {
  const api = useApi()
  return useLeaveLike((id) => api.exitRoom(id), { error: '没退出去', done: (n) => `已退出 ${n}` }, onDone)
}

/** 解散房间 (owner): everyone leaves, the invite and pending knocks are gone. */
export function useDissolveRoom(onDone: () => void) {
  const api = useApi()
  return useLeaveLike((id) => api.dissolveRoom(id), { error: '没解散成', done: (n) => `${n} 已解散` }, onDone)
}
