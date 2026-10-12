/**
 * Error mapping for the HTTP surfaces: every failure becomes `{ error: { code, message } }` with the
 * status from `httpStatusFor` (§9). Bodies and queries are validated with the protocol schemas.
 */
import {
  type ErrorBody,
  httpStatusFor,
  isWireErrorCode,
  PeersError,
  paramsError,
} from '@agent-peers/protocol'
import type { Context } from 'hono'
import type { z } from 'zod'
import type { Logger } from '../config'

/** Request bodies are small JSON documents; anything larger is refused before parsing. */
export const MAX_BODY_BYTES = 64 * 1024

export const NO_STORE = 'no-store'

function asPeersError(error: unknown, logger: Logger): PeersError {
  if (error instanceof PeersError) return error
  logger.error('http request failed', error)
  return new PeersError('internal', 'internal error')
}

export function errorBody(error: PeersError): ErrorBody {
  const code = isWireErrorCode(error.code) ? error.code : 'internal'
  return {
    error: {
      code,
      message: error.message,
      ...(error.retryAfterMs !== undefined ? { retry_after_ms: error.retryAfterMs } : {}),
    },
  }
}

/** The JSON error response for anything thrown by a route. */
export function errorResponse(error: unknown, logger: Logger): Response {
  const peers = asPeersError(error, logger)
  const body = errorBody(peers)
  const headers = new Headers({
    'content-type': 'application/json; charset=utf-8',
    'cache-control': NO_STORE,
  })
  if (peers.retryAfterMs !== undefined)
    headers.set('retry-after', String(Math.ceil(peers.retryAfterMs / 1000)))
  return new Response(JSON.stringify(body), { status: httpStatusFor(body.error.code), headers })
}

/** Validates `value` with a protocol schema; failures map to `invalid_params` / `invalid_name` / …. */
export function parseWith<S extends z.ZodType>(schema: S, value: unknown, context: string): z.output<S> {
  const parsed = schema.safeParse(value)
  if (!parsed.success) throw paramsError(parsed.error, context)
  return parsed.data
}

const tooLarge = () => new PeersError('payload_too_large', 'request body too large')

/**
 * Reads a body of at most `maxBytes`, counting bytes as they stream in, so a chunked body with no
 * Content-Length is cut off at the limit instead of being buffered whole.
 */
export async function readLimited(request: Request, maxBytes: number = MAX_BODY_BYTES): Promise<string> {
  const length = Number(request.headers.get('content-length') ?? '0')
  if (length > maxBytes) throw tooLarge()
  if (request.body === null) return ''
  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > maxBytes) {
      await drain(reader)
      throw tooLarge()
    }
    chunks.push(value)
  }
  return new TextDecoder().decode(Buffer.concat(chunks, total))
}

/** How much of an oversized body is discarded to keep the connection reusable before giving up. */
const DRAIN_LIMIT_BYTES = 16 * MAX_BODY_BYTES

/**
 * Reads and discards the rest of an oversized body (Bun's `maxRequestBodySize` only applies to a
 * declared Content-Length), so a keep-alive connection stays usable. Past `DRAIN_LIMIT_BYTES` the
 * stream is cancelled instead; the client then has to open a new connection.
 */
async function drain(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<void> {
  let drained = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) return
      drained += value.byteLength
      if (drained > DRAIN_LIMIT_BYTES) {
        await reader.cancel()
        return
      }
    }
  } catch {
    // The stream failed or was aborted by the client: there is nothing left to drain.
  }
}

const readText = (c: Context): Promise<string> => readLimited(c.req.raw)

export function isJson(c: Context): boolean {
  return /^application\/json\b/i.test(c.req.header('content-type') ?? '')
}

/**
 * Reads a JSON body. `application/json` is required, which also keeps HTML forms on other sites
 * from posting to the API. An empty body reads as `{}` when `optional` is set.
 */
export async function readJson(c: Context, optional = false): Promise<unknown> {
  const text = await readText(c)
  if (text.trim() === '') {
    if (optional) return {}
    throw new PeersError('invalid_request', 'a JSON body is required')
  }
  if (!isJson(c)) throw new PeersError('invalid_request', 'expected Content-Type: application/json')
  try {
    return JSON.parse(text) as unknown
  } catch {
    throw new PeersError('parse_error', 'the body is not valid JSON')
  }
}

/** Reads and validates a JSON body in one step. */
export async function body<S extends z.ZodType>(
  c: Context,
  schema: S,
  context: string,
  optional = false,
): Promise<z.output<S>> {
  return parseWith(schema, await readJson(c, optional), context)
}

/** Reads an `application/x-www-form-urlencoded` body as a plain record (the login form). */
export async function readForm(c: Context): Promise<Readonly<Record<string, string>>> {
  const params = new URLSearchParams(await readText(c))
  return Object.fromEntries(params.entries())
}

export function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': NO_STORE },
  })
}

export const OK: Readonly<{ ok: true }> = Object.freeze({ ok: true })

/** Validates one path parameter. */
export function param<S extends z.ZodType>(c: Context, name: string, schema: S): z.output<S> {
  return parseWith(schema, c.req.param(name), `invalid ${name}`)
}
