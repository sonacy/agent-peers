/** Error codes (§6.5), the PeersError class and the JSON-RPC 2.0 error mapping. */

/** §6.5: values of `error.data.code` a hub sends. */
export const PROTOCOL_ERROR_CODES = [
  'unauthorized',
  'forbidden',
  'rename_conflict',
  'invite_closed',
  'already_member',
  'knock_pending',
  'adapter_outdated',
  'version_unsupported',
  'unknown_session',
  'room_not_found',
  'invite_invalid',
  'handle_taken',
  'invalid_name',
  'target_not_found',
  'target_offline',
  'target_busy',
  'ask_closed',
  'ask_taken',
  'payload_too_large',
  'rate_limited',
  'internal',
] as const
export type ProtocolErrorCode = (typeof PROTOCOL_ERROR_CODES)[number]

/** Standard JSON-RPC 2.0 errors, named. `internal` (-32603) is shared with the protocol list. */
export const RPC_ERROR_CODES = [
  'parse_error',
  'invalid_request',
  'method_not_found',
  'invalid_params',
] as const
export type RpcErrorCode = (typeof RPC_ERROR_CODES)[number]

/** Raised locally by a client, never sent by a hub. */
export const CLIENT_ERROR_CODES = [
  'disconnected',
  'closed',
  'timeout',
  'not_connected',
  'invalid_result',
  'invalid_frame',
  'insecure_transport',
  'session_not_open',
] as const
export type ClientErrorCode = (typeof CLIENT_ERROR_CODES)[number]

/** Codes that can travel on the wire (in `error.data.code`, or as a standard JSON-RPC code). */
export type WireErrorCode = ProtocolErrorCode | RpcErrorCode
export type ErrorCode = WireErrorCode | ClientErrorCode

/** JSON-RPC numeric codes. Protocol errors use the implementation-defined server range. */
export const JSON_RPC = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
  APPLICATION_ERROR: -32000,
} as const

const NUMERIC_BY_CODE: Readonly<Partial<Record<ErrorCode, number>>> = {
  parse_error: JSON_RPC.PARSE_ERROR,
  invalid_request: JSON_RPC.INVALID_REQUEST,
  method_not_found: JSON_RPC.METHOD_NOT_FOUND,
  invalid_params: JSON_RPC.INVALID_PARAMS,
  internal: JSON_RPC.INTERNAL_ERROR,
}

const CODE_BY_NUMERIC: Readonly<Record<number, WireErrorCode>> = {
  [JSON_RPC.PARSE_ERROR]: 'parse_error',
  [JSON_RPC.INVALID_REQUEST]: 'invalid_request',
  [JSON_RPC.METHOD_NOT_FOUND]: 'method_not_found',
  [JSON_RPC.INVALID_PARAMS]: 'invalid_params',
  [JSON_RPC.INTERNAL_ERROR]: 'internal',
}

const WIRE_CODES: ReadonlySet<string> = new Set([...PROTOCOL_ERROR_CODES, ...RPC_ERROR_CODES])
const ALL_CODES: ReadonlySet<string> = new Set([...WIRE_CODES, ...CLIENT_ERROR_CODES])

export function isProtocolErrorCode(value: unknown): value is ProtocolErrorCode {
  return typeof value === 'string' && (PROTOCOL_ERROR_CODES as readonly string[]).includes(value)
}

export function isWireErrorCode(value: unknown): value is WireErrorCode {
  return typeof value === 'string' && WIRE_CODES.has(value)
}

export function isErrorCode(value: unknown): value is ErrorCode {
  return typeof value === 'string' && ALL_CODES.has(value)
}

export type ErrorData = Readonly<Record<string, unknown>>

export class PeersError extends Error {
  override readonly name = 'PeersError'
  readonly code: ErrorCode
  /** Extra fields carried in `error.data` (never includes `code`). */
  readonly data: ErrorData | undefined
  /** `rate_limited` errors carry `retry_after_ms`. */
  readonly retryAfterMs: number | undefined

  constructor(
    code: ErrorCode,
    message: string = code,
    data?: Record<string, unknown>,
    options?: ErrorOptions,
  ) {
    super(message, options)
    this.code = code
    const rest = data ? Object.fromEntries(Object.entries(data).filter(([key]) => key !== 'code')) : {}
    this.data = Object.keys(rest).length > 0 ? Object.freeze(rest) : undefined
    const retry = rest.retry_after_ms
    this.retryAfterMs = typeof retry === 'number' ? retry : undefined
  }
}

export function isPeersError(error: unknown, code?: ErrorCode): error is PeersError {
  return error instanceof PeersError && (code === undefined || error.code === code)
}

/** Wraps anything thrown into a PeersError; unknown failures become `internal`. */
export function toPeersError(error: unknown, fallback: ErrorCode = 'internal'): PeersError {
  if (error instanceof PeersError) return error
  const message = error instanceof Error ? error.message : String(error)
  return new PeersError(fallback, message || fallback, undefined, { cause: error })
}

/** The JSON-RPC `error` member. */
export interface RpcErrorObject {
  readonly code: number
  readonly message: string
  readonly data?: unknown
}

export function rpcCodeFor(code: ErrorCode): number {
  return NUMERIC_BY_CODE[code] ?? JSON_RPC.APPLICATION_ERROR
}

const MAX_ERROR_MESSAGE_CHARS = 1024

/**
 * Builds the JSON-RPC error object a hub sends: `{ code, message, data: { code, ...data } }`.
 * Anything that is not a PeersError becomes `internal` with a generic message, so internals don't leak.
 */
export function toRpcError(error: unknown): RpcErrorObject {
  const peers = error instanceof PeersError ? error : new PeersError('internal', 'internal error')
  const code = isWireErrorCode(peers.code) ? peers.code : 'internal'
  return {
    code: rpcCodeFor(code),
    message: peers.message.slice(0, MAX_ERROR_MESSAGE_CHARS) || code,
    data: { ...peers.data, code },
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

/** Maps a received JSON-RPC error to a PeersError, preferring `error.data.code`. */
export function fromRpcError(error: RpcErrorObject): PeersError {
  const data = asRecord(error.data)
  const code: ErrorCode = isWireErrorCode(data?.code)
    ? data.code
    : (CODE_BY_NUMERIC[error.code] ?? 'internal')
  return new PeersError(code, error.message || code, data)
}

const HTTP_STATUS: Readonly<Partial<Record<ErrorCode, number>>> = {
  unauthorized: 401,
  forbidden: 403,
  unknown_session: 404,
  room_not_found: 404,
  invite_invalid: 404,
  target_not_found: 404,
  method_not_found: 404,
  invite_closed: 410,
  rename_conflict: 409,
  already_member: 409,
  knock_pending: 409,
  adapter_outdated: 409,
  handle_taken: 409,
  target_offline: 409,
  ask_closed: 409,
  ask_taken: 409,
  invalid_name: 400,
  invalid_params: 400,
  invalid_request: 400,
  parse_error: 400,
  version_unsupported: 426,
  payload_too_large: 413,
  target_busy: 429,
  rate_limited: 429,
}

/** HTTP status for an error code on the member API (§9). */
export function httpStatusFor(code: ErrorCode): number {
  return HTTP_STATUS[code] ?? 500
}
