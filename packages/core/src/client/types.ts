/** Public option and event types for HubClient. */

import type { BridgeInfo, MethodName, ParamsOf, PeersError, ResultOf, Welcome } from '@agent-peers/protocol'
import type { BackoffOptions, RandomSource } from '../util/backoff'
import type { Clock } from '../util/clock'
import type { WebSocketFactory } from './socket'

export interface HubClientOptions {
  readonly bridge: BridgeInfo
  /** Protocol versions offered in `hello` (default `["agent-peers/0.3"]`). */
  readonly protocols?: readonly string[]
  /** Per-request timeout (default 30 s). Also bounds opening the socket. */
  readonly requestTimeoutMs?: number
  /** Overrides the hub's `heartbeat_ms` (tests). */
  readonly heartbeatMs?: number
  /** `false` disables automatic reconnect; an object tunes the backoff (default 1 s → 30 s ±20 %). */
  readonly reconnect?: boolean | Partial<BackoffOptions>
  /** Allow plain ws:// to public hosts (PROTOCOL §1 `--insecure`). */
  readonly insecure?: boolean
  readonly clock?: Clock
  readonly random?: RandomSource
  readonly webSocketFactory?: WebSocketFactory
}

export type ClientState = 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'closed'

export type LifecycleEvent =
  | { readonly type: 'connecting'; readonly url: string; readonly attempt: number }
  | { readonly type: 'connected'; readonly welcome: Welcome; readonly reconnected: boolean }
  | { readonly type: 'disconnected'; readonly reason: string; readonly code?: number }
  | {
      readonly type: 'reconnecting'
      readonly attempt: number
      readonly delayMs: number
      readonly at: number
      readonly error?: PeersError
    }
  | { readonly type: 'closed'; readonly reason: string; readonly error?: PeersError }
  /** Non-fatal problems: invalid frames, failed resync steps. */
  | { readonly type: 'error'; readonly error: PeersError }

export interface RequestOptions {
  readonly timeoutMs?: number
}

export type Requester = <M extends MethodName>(method: M, params: ParamsOf<M>) => Promise<ResultOf<M>>

/** Passed to resync hooks after every successful `hello`. Requests here bypass the connected gate. */
export interface ResyncContext {
  readonly reconnected: boolean
  readonly request: Requester
  /** Tells the client a session came back with a new id, so queued retries are re-addressed. */
  remapSession(oldId: string, newId: string): void
}

export type ResyncHook = (context: ResyncContext) => Promise<void>
