/** Request handler types for the WS dispatcher. */
import type { MethodName, ParsedParamsOf } from '@agent-peers/protocol'
import type { HubConfig } from '../../config'
import type { Actor } from '../../services/access'
import type { Services } from '../../services/index'
import type { Connection } from '../connection'
import type { Registry } from '../registry'

export interface HandlerContext {
  readonly conn: Connection
  readonly services: Services
  readonly registry: Registry
  readonly config: HubConfig
}

/** A result, plus work that must happen after the response frame is sent (replay, §4). */
export interface Reply {
  readonly result: unknown
  readonly after?: () => void
}

export type Handler<M extends MethodName> = (ctx: HandlerContext, params: ParsedParamsOf<M>) => Reply

export type HandlerTable = { readonly [M in MethodName]?: Handler<M> }

export const reply = (result: unknown, after?: () => void): Reply => (after ? { result, after } : { result })

export const EMPTY: Reply = Object.freeze({ result: {} })

export function sessionActor(ctx: HandlerContext, sessionId: string): Actor {
  return { kind: 'session', memberId: ctx.conn.memberId, sessionId }
}
