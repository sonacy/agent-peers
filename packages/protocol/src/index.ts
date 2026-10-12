/** @agent-peers/protocol: the single source of truth for PROTOCOL.md v0.3. Pure code, no I/O. */
export const PACKAGE_NAME = '@agent-peers/protocol'

export * from './card'
export * from './constants'
export * from './envelope'
export * from './errors'
export * from './ids'
export * from './join-prompt'
export * from './jsonrpc'
export * from './member-api'
export * from './message'
export * from './methods/index'
export * from './methods/messages'
export * from './methods/rooms'
export * from './methods/session'
export * from './names'
export * from './notifications'
export * from './room'
export {
  EmptySchema,
  IdSchema,
  lineSchema,
  MetaSchema,
  NameSchema,
  SeqSchema,
  TextSchema,
  TimestampSchema,
} from './schema-util'
export * from './text'
export type { DeepReadonly } from './types'
export * from './versions'
