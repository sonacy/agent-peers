/**
 * Live events → query cache (DASHBOARD §11): patch what the event fully describes, invalidate the
 * rest. Never polls; a gap in the stream triggers a full refetch instead (see stream.ts).
 */
import type { QueryClient } from '@tanstack/react-query'
import { type AsksData, patchAskInPages, replaceCardInRoom, replaceSession } from '../api/cache'
import { queryKeys } from '../api/keys'
import type { RoomDetail, SessionCard } from '../api/types'
import type { MemberEvent } from './events'

type Sessions = readonly SessionCard[]

const invalidate = (client: QueryClient, queryKey: readonly unknown[]): void => {
  void client.invalidateQueries({ queryKey })
}

/** Puts a fresh card into my sessions list (when it's mine) and into every cached room detail. */
function applyCard(client: QueryClient, card: SessionCard, roomId?: string): void {
  const sessions = replaceSession(client.getQueryData<Sessions>(queryKeys.sessions), card)
  if (sessions !== undefined) client.setQueryData<Sessions>(queryKeys.sessions, sessions)
  for (const [key, detail] of client.getQueriesData<RoomDetail>({ queryKey: queryKeys.roomAll })) {
    const next = replaceCardInRoom(detail, card)
    if (next !== undefined) client.setQueryData(key, next)
    else if (roomId !== undefined && key[1] === roomId) invalidate(client, key)
  }
}

/** Ask and message events for one Q&A arrive together; one refetch covers the whole burst. */
export const ASKS_REFRESH_MS = 200

const pendingRefresh = new WeakMap<QueryClient, ReturnType<typeof setTimeout>>()

/** Keeps only the first page, so the next fetch of a feed nobody is looking at is one request. */
function firstPageOnly(data: AsksData | undefined): AsksData | undefined {
  if (data === undefined || data.pages.length <= 1) return data
  return { pages: data.pages.slice(0, 1), pageParams: data.pageParams.slice(0, 1) }
}

function refreshAsks(client: QueryClient): void {
  pendingRefresh.delete(client)
  for (const query of client.getQueryCache().findAll({ queryKey: queryKeys.asksAll })) {
    if (query.getObserversCount() === 0) client.setQueryData(query.queryKey, firstPageOnly)
  }
  // Only feeds on screen refetch now; the others are marked stale and load page one when opened.
  void client.invalidateQueries({ queryKey: queryKeys.asksAll, refetchType: 'active' })
}

/** Coalesces the asks-feed refetches of a burst of events into one, ASKS_REFRESH_MS later. */
function scheduleAsksRefresh(client: QueryClient): void {
  if (pendingRefresh.has(client)) return
  pendingRefresh.set(
    client,
    setTimeout(() => refreshAsks(client), ASKS_REFRESH_MS),
  )
}

type AskMessage = Extract<MemberEvent, { name: 'message' }>['data']['message']

/** Puts a reply into its thread in every loaded page; false when no loaded page holds that ask. */
function patchAnswer(client: QueryClient, message: AskMessage): boolean {
  let found = false
  for (const [key, data] of client.getQueriesData<AsksData>({ queryKey: queryKeys.asksAll })) {
    if (data === undefined) continue
    let hit = false
    const pages = data.pages.map((page) => ({
      ...page,
      asks: page.asks.map((thread) => {
        if (thread.ask.ask_id !== message.re) return thread
        hit = true
        return { ...thread, answer: message }
      }),
    }))
    if (hit) {
      found = true
      client.setQueryData(key, { ...data, pages })
    }
  }
  return found
}

function hasAnswer(client: QueryClient, askId: string): boolean {
  return client
    .getQueriesData<AsksData>({ queryKey: queryKeys.asksAll })
    .some(([, data]) =>
      data?.pages.some((page) => page.asks.some((t) => t.ask.ask_id === askId && t.answer != null)),
    )
}

function applyAsk(client: QueryClient, event: Extract<MemberEvent, { name: 'ask' }>): void {
  const { ask } = event.data
  let missing = false
  for (const [key, data] of client.getQueriesData<AsksData>({ queryKey: queryKeys.asksAll })) {
    const next = patchAskInPages(data, ask)
    if (next === undefined) missing = true
    else client.setQueryData(key, next)
  }
  // New threads, or an answer (or decline note) whose text hasn't come as a `message` yet, need
  // the feed itself.
  const closed = ask.state === 'answered' || ask.state === 'declined'
  if (missing || (closed && !hasAnswer(client, ask.ask_id))) scheduleAsksRefresh(client)
}

function applyMessage(client: QueryClient, message: AskMessage): void {
  if (message.kind === 'reply' && message.re != null && patchAnswer(client, message)) return
  if (message.kind === 'reply' || message.kind === 'ask') scheduleAsksRefresh(client)
}

export function applyMemberEvent(client: QueryClient, event: MemberEvent): void {
  switch (event.name) {
    case 'session':
      if (
        replaceSession(client.getQueryData<Sessions>(queryKeys.sessions), event.data.session) === undefined
      ) {
        invalidate(client, queryKeys.sessions)
      }
      applyCard(client, event.data.session)
      return
    case 'presence':
      applyCard(client, event.data.card, event.data.room_id)
      return
    case 'room':
      invalidate(client, queryKeys.rooms)
      invalidate(client, queryKeys.room(event.data.room_id))
      invalidate(client, queryKeys.roomSearchAll)
      if (event.data.change !== 'updated' && event.data.change !== 'invite')
        invalidate(client, queryKeys.sessions)
      return
    case 'knock':
      invalidate(client, queryKeys.rooms)
      invalidate(client, queryKeys.room(event.data.knock.room_id))
      invalidate(client, queryKeys.roomSearchAll)
      invalidate(client, queryKeys.myKnocks)
      return
    case 'ask':
      applyAsk(client, event)
      return
    case 'message':
      applyMessage(client, event.data.message)
      return
  }
}
