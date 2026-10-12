export const PACKAGE_NAME = '@agent-peers/core'

/** Wire types and helpers live in @agent-peers/protocol; re-exported so bridge code can use one import. */
export * from '@agent-peers/protocol'
/** @deprecated aliases kept for code written against the old core wire layer. */
export { isPeersError as isHubError, PeersError as HubError } from '@agent-peers/protocol'
export { HubClient } from './client/hub-client'
export type { WebSocketFactory, WebSocketLike } from './client/socket'
export { defaultWebSocketFactory } from './client/socket'
export type {
  ClientState,
  HubClientOptions,
  LifecycleEvent,
  Requester,
  RequestOptions,
  ResyncContext,
  ResyncHook,
} from './client/types'
export { assertTransportAllowed, isPrivateHost, toWebSocketUrl } from './client/url'
export type { InboxJournalOptions, OpenAskQuery, RoomAck } from './journal/inbox-journal'
export { InboxJournal, JournalError, SessionJournal } from './journal/inbox-journal'
export type { AskStatus, Injection, InjectionChannel, JournalEntry, JournalMessage } from './journal/records'
export type { AskInput, ChatInput, ProgressInput, ReplyInput } from './session/messages'
export type { JoinTarget, SessionHandleOptions } from './session/session-handle'
export { SessionHandle } from './session/session-handle'
export type { KnockView, SessionRoom, SessionStatus, SessionView } from './session/view'
export type { Backoff, BackoffOptions, RandomSource } from './util/backoff'
export { backoffDelay, createBackoff, DEFAULT_BACKOFF, resolveBackoff } from './util/backoff'
export type { Clock, TimerHandle } from './util/clock'
export { systemClock } from './util/clock'
export type { Listener, Unsubscribe } from './util/emitter'
