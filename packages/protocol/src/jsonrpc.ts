/** JSON-RPC 2.0 framing (PROTOCOL §1): one message per text frame, at most 256 KiB. */
import { z } from 'zod'
import { MAX_FRAME_BYTES } from './constants'
import { PeersError, type RpcErrorObject, toRpcError } from './errors'
import { utf8ByteLength } from './text'

export type RpcId = number | string

const IdSchema = z.union([z.number().int(), z.string().max(128)])

export const RpcErrorSchema = z.object({
  code: z.number().int(),
  message: z.string(),
  data: z.unknown().optional(),
})

export const RequestFrameSchema = z.object({
  jsonrpc: z.literal('2.0'),
  id: IdSchema,
  method: z.string().min(1).max(128),
  params: z.unknown().optional(),
})

export const NotificationFrameSchema = RequestFrameSchema.omit({ id: true })

export const ResultFrameSchema = z.object({ jsonrpc: z.literal('2.0'), id: IdSchema, result: z.unknown() })

export const ErrorFrameSchema = z.object({
  jsonrpc: z.literal('2.0'),
  id: z.union([IdSchema, z.null()]),
  error: RpcErrorSchema,
})

export type DecodedFrame =
  | { readonly type: 'request'; readonly id: RpcId; readonly method: string; readonly params: unknown }
  | { readonly type: 'notification'; readonly method: string; readonly params: unknown }
  | { readonly type: 'result'; readonly id: RpcId; readonly result: unknown }
  | { readonly type: 'error'; readonly id: RpcId | null; readonly error: RpcErrorObject }
  /** Unusable frame. `id` is set when the frame parsed far enough to carry one. */
  | { readonly type: 'invalid'; readonly id: RpcId | null; readonly error: PeersError }

/** True when the frame's UTF-8 size is within `maxBytes`; cheap for short strings. */
export function frameFits(frame: string, maxBytes: number = MAX_FRAME_BYTES): boolean {
  if (frame.length > maxBytes) return false
  if (frame.length * 3 <= maxBytes) return true
  return utf8ByteLength(frame) <= maxBytes
}

export function assertFrameSize(frame: string, maxBytes: number = MAX_FRAME_BYTES): string {
  if (!frameFits(frame, maxBytes)) {
    throw new PeersError(
      'payload_too_large',
      `frame is ${utf8ByteLength(frame)} bytes; the limit is ${maxBytes}`,
    )
  }
  return frame
}

const invalid = (
  id: RpcId | null,
  code: 'parse_error' | 'invalid_request' | 'payload_too_large',
  message: string,
) => ({ type: 'invalid', id, error: new PeersError(code, message) }) as const

function idOf(value: unknown): RpcId | null {
  if (typeof value !== 'object' || value === null || !('id' in value)) return null
  const parsed = IdSchema.safeParse(value.id)
  return parsed.success ? parsed.data : null
}

function classify(value: unknown): DecodedFrame {
  const request = RequestFrameSchema.safeParse(value)
  if (request.success) {
    const { id, method, params } = request.data
    return { type: 'request', id, method, params }
  }
  const notification = NotificationFrameSchema.safeParse(value)
  if (notification.success && !(typeof value === 'object' && value !== null && 'id' in value)) {
    return { type: 'notification', method: notification.data.method, params: notification.data.params }
  }
  const result = ResultFrameSchema.safeParse(value)
  if (result.success && !(typeof value === 'object' && value !== null && 'error' in value)) {
    return { type: 'result', id: result.data.id, result: result.data.result }
  }
  const error = ErrorFrameSchema.safeParse(value)
  if (error.success) return { type: 'error', id: error.data.id, error: error.data.error }
  return invalid(idOf(value), 'invalid_request', 'not a JSON-RPC 2.0 message')
}

/** Decodes one text frame. Binary frames, oversize frames, bad JSON and batches are `invalid`. */
export function decodeFrame(data: unknown, maxBytes: number = MAX_FRAME_BYTES): DecodedFrame {
  if (typeof data !== 'string') return invalid(null, 'invalid_request', 'binary frame')
  if (!frameFits(data, maxBytes)) return invalid(null, 'payload_too_large', `frame exceeds ${maxBytes} bytes`)
  let value: unknown
  try {
    value = JSON.parse(data)
  } catch {
    return invalid(null, 'parse_error', 'malformed JSON')
  }
  if (Array.isArray(value)) return invalid(null, 'invalid_request', 'batches are not supported')
  return classify(value)
}

/** Throws `payload_too_large` when the encoded frame is over `maxBytes`. */
export function encodeRequest(
  id: RpcId,
  method: string,
  params: unknown,
  maxBytes = MAX_FRAME_BYTES,
): string {
  return assertFrameSize(JSON.stringify({ jsonrpc: '2.0', id, method, params }), maxBytes)
}

export function encodeNotification(method: string, params: unknown, maxBytes = MAX_FRAME_BYTES): string {
  return assertFrameSize(JSON.stringify({ jsonrpc: '2.0', method, params }), maxBytes)
}

export function encodeResult(id: RpcId, result: unknown, maxBytes = MAX_FRAME_BYTES): string {
  return assertFrameSize(JSON.stringify({ jsonrpc: '2.0', id, result }), maxBytes)
}

/** Encodes an error response. Non-PeersErrors are reported as a generic `internal` error. */
export function encodeError(id: RpcId | null, error: unknown): string {
  return JSON.stringify({ jsonrpc: '2.0', id, error: toRpcError(error) })
}
