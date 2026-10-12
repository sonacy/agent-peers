/** TanStack Query keys for the member API (DASHBOARD §11). Prefix keys invalidate whole families. */
import type { AskFilter } from './types'

export const queryKeys = {
  me: ['me'] as const,
  sessions: ['sessions'] as const,
  rooms: ['rooms'] as const,
  roomAll: ['room'] as const,
  room: (roomId: string) => ['room', roomId] as const,
  roomSearchAll: ['room-search'] as const,
  roomSearch: (q: string) => ['room-search', q] as const,
  myKnocks: ['my-knocks'] as const,
  asksAll: ['asks'] as const,
  asks: (filter: AskFilter) => ['asks', filter] as const,
} as const
