/** Query hooks for the member API (DASHBOARD §11). Live updates arrive over SSE, so no polling. */
import { type QueryClient, useInfiniteQuery, useQuery } from '@tanstack/react-query'
import type { AsksData } from './cache'
import { useApi } from './context'
import { isForbidden, isNotFound, isUnauthorized } from './errors'
import { queryKeys } from './keys'
import type { AskFilter } from './types'

/** Never retry a signed-out, forbidden or missing-resource answer; retry other failures once. */
export function shouldRetry(failureCount: number, error: unknown): boolean {
  if (isUnauthorized(error) || isNotFound(error) || isForbidden(error)) return false
  return failureCount < 1
}

export function useMe() {
  const api = useApi()
  return useQuery({ queryKey: queryKeys.me, queryFn: () => api.me(), retry: shouldRetry })
}

export function useSessions() {
  const api = useApi()
  return useQuery({ queryKey: queryKeys.sessions, queryFn: () => api.sessions(), retry: shouldRetry })
}

export function useMyRooms() {
  const api = useApi()
  return useQuery({ queryKey: queryKeys.rooms, queryFn: () => api.rooms(), retry: shouldRetry })
}

/**
 * Room display names (`支付联调`) by id, from my rooms, so a room reads the same everywhere; rooms
 * not in the list (left or dissolved) fall back to their slug.
 */
export function useRoomTitles(): (room: { readonly room_id: string; readonly name: string }) => string {
  const rooms = useMyRooms()
  const titles = new Map(
    (rooms.data ?? []).map((r) => [r.room.room_id, r.room.display_name ?? r.room.name] as const),
  )
  return (room) => titles.get(room.room_id) ?? room.name
}

export function useRoom(roomId: string) {
  const api = useApi()
  return useQuery({ queryKey: queryKeys.room(roomId), queryFn: () => api.room(roomId), retry: shouldRetry })
}

export function useRoomSearch(q: string, enabled = true) {
  const api = useApi()
  return useQuery({
    queryKey: queryKeys.roomSearch(q),
    queryFn: () => api.searchRooms(q),
    enabled,
    retry: shouldRetry,
  })
}

export function useAsks(filter: AskFilter) {
  const api = useApi()
  return useInfiniteQuery({
    queryKey: queryKeys.asks(filter),
    queryFn: ({ pageParam }) => api.asks(filter, pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.next_cursor ?? undefined,
    retry: shouldRetry,
  })
}

/** Every loaded thread across pages, newest first as the hub sends them. */
export function flattenAsks(data: AsksData | undefined) {
  return data?.pages.flatMap((page) => page.asks) ?? []
}

/** Refetch everything after a gap in the live stream (missed events). */
export function resyncAll(client: QueryClient): Promise<void> {
  return client.invalidateQueries()
}
