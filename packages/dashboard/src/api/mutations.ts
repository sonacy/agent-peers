/**
 * Session mutations with optimistic updates (DASHBOARD §4.1): the accepting toggle, rename and
 * remove-from-room patch the cache at once and roll back with a toast if the hub refuses.
 */
import { type QueryClient, useMutation, useQueryClient } from '@tanstack/react-query'
import { useToast } from '../components/ui/toast'
import { patchSessionInList, removeRoomFromSession, replaceSession, restoreSessionFields } from './cache'
import { useApi } from './context'
import { friendlyError, signOutWith } from './errors'
import { queryKeys } from './keys'
import type { SessionCard, SessionPatch } from './types'

type Sessions = readonly SessionCard[]

/** The card as it was before this mutation touched it. */
interface Snapshot {
  readonly before: SessionCard | undefined
}

/**
 * Mutations on one session share a key and a scope: they run one after another (a quick off/on
 * can't land out of order) and know whether another change to the same card is still in flight.
 */
export const sessionMutationKey = (sessionId: string) => ['session', sessionId] as const

async function optimistic(
  client: QueryClient,
  sessionId: string,
  update: (list: Sessions | undefined) => Sessions | undefined,
): Promise<Snapshot> {
  await client.cancelQueries({ queryKey: queryKeys.sessions })
  const previous = client.getQueryData<Sessions>(queryKeys.sessions)
  const next = update(previous)
  if (next !== undefined) client.setQueryData<Sessions>(queryKeys.sessions, next)
  return { before: previous?.find((s) => s.session_id === sessionId) }
}

/**
 * Puts back only what this mutation changed on its own card. Restoring the whole list snapshot
 * would also wipe other cards' optimistic changes and live events that arrived in the meantime.
 */
function rollback(
  client: QueryClient,
  snapshot: Snapshot | undefined,
  undo: (current: SessionCard, before: SessionCard) => SessionCard,
): void {
  const before = snapshot?.before
  if (before === undefined) return
  client.setQueryData<Sessions>(queryKeys.sessions, (list) =>
    list?.map((s) => (s.session_id === before.session_id ? undo(s, before) : s)),
  )
}

/** True while another change to the same card is still on its way (this one counts as pending). */
function othersPending(client: QueryClient, sessionId: string): boolean {
  return client.isMutating({ mutationKey: sessionMutationKey(sessionId) }) > 1
}

function storeServerCard(client: QueryClient, card: SessionCard): void {
  // A later toggle is still in flight: its optimistic value wins until it lands too.
  if (othersPending(client, card.session_id)) return
  const next = replaceSession(client.getQueryData<Sessions>(queryKeys.sessions), card)
  if (next === undefined) void client.invalidateQueries({ queryKey: queryKeys.sessions })
  else client.setQueryData<Sessions>(queryKeys.sessions, next)
}

/** Once the last change to a card settles, refetch the list so it can't stay wrong after a rollback. */
function reconcile(client: QueryClient, sessionId: string): Promise<void> | undefined {
  if (othersPending(client, sessionId)) return undefined
  return client.invalidateQueries({ queryKey: queryKeys.sessions })
}

export interface PatchSessionVars {
  readonly sessionId: string
  readonly patch: SessionPatch
}

/**
 * `PATCH /v0/me/sessions/:id`: accepting toggle, 暂停, and 改名 (title and/or handle). `sessionId`
 * scopes the hook so changes to one card are serialized.
 */
export function usePatchSession(sessionId: string, errorTitle = '没改成') {
  const api = useApi()
  const client = useQueryClient()
  const { toast } = useToast()
  return useMutation({
    mutationKey: sessionMutationKey(sessionId),
    scope: { id: `session:${sessionId}` },
    mutationFn: ({ sessionId: id, patch }: PatchSessionVars) => api.patchSession(id, patch),
    onMutate: ({ sessionId: id, patch }) =>
      optimistic(client, id, (list) => patchSessionInList(list, id, patch)),
    onError: (error, { patch }, snapshot) => {
      rollback(client, snapshot, (current, before) => restoreSessionFields(current, before, patch))
      toast({ title: errorTitle, description: friendlyError(error), tone: 'danger' })
    },
    onSuccess: (card, { patch }) => {
      storeServerCard(client, card)
      if (patch.handle !== undefined && patch.room_id !== undefined) {
        void client.invalidateQueries({ queryKey: queryKeys.room(patch.room_id) })
      }
    },
    onSettled: (_card, _error, { sessionId: id }) => reconcile(client, id),
  })
}

export interface RemoveFromRoomVars {
  readonly sessionId: string
  readonly roomId: string
}

/** Puts the room entry back on the card if it's missing (undoing an optimistic removal). */
function withRoomBack(current: SessionCard, before: SessionCard, roomId: string): SessionCard {
  const entry = before.rooms.find((r) => r.room_id === roomId)
  if (entry === undefined || current.rooms.some((r) => r.room_id === roomId)) return current
  return { ...current, rooms: [...current.rooms, entry] }
}

/** `DELETE /v0/me/rooms/:id/sessions/:sid`: releases the handle, keeps the person's grant. */
export function useRemoveFromRoom(sessionId: string) {
  const api = useApi()
  const client = useQueryClient()
  const { toast } = useToast()
  return useMutation({
    mutationKey: sessionMutationKey(sessionId),
    scope: { id: `session:${sessionId}` },
    mutationFn: ({ sessionId: id, roomId }: RemoveFromRoomVars) => api.removeSession(roomId, id),
    onMutate: ({ sessionId: id, roomId }) =>
      optimistic(client, id, (list) => removeRoomFromSession(list, id, roomId)),
    onError: (error, { roomId }, snapshot) => {
      rollback(client, snapshot, (current, before) => withRoomBack(current, before, roomId))
      toast({ title: '没移出去', description: friendlyError(error), tone: 'danger' })
    },
    onSuccess: (_data, { roomId }) => {
      void client.invalidateQueries({ queryKey: queryKeys.room(roomId) })
      void client.invalidateQueries({ queryKey: queryKeys.rooms })
    },
    onSettled: (_data, _error, { sessionId: id }) => reconcile(client, id),
  })
}

/** `POST /app/login`: consumes the one-time code and sets the session cookie. */
export function useLogin() {
  const api = useApi()
  const client = useQueryClient()
  return useMutation({
    mutationFn: (code: string) => api.login(code),
    onSuccess: () => client.invalidateQueries(),
  })
}

/**
 * `POST /v0/me/logout`: drops the cookie and every cached query, only once the hub confirmed it.
 * A failed logout leaves the cookie valid, so the page must not claim it signed out.
 */
export function useLogout() {
  const api = useApi()
  const client = useQueryClient()
  return useMutation({
    mutationFn: () => signOutWith(() => api.logout()),
    onSuccess: () => client.clear(),
  })
}
