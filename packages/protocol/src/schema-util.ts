/** Shared zod building blocks. Issue params carry the protocol error code a failure maps to. */
import { z } from 'zod'
import { MAX_ID_LENGTH, MAX_META_BYTES, MAX_RAW_LINE_CHARS, MAX_TEXT_BYTES } from './constants'
import { isValidName } from './names'
import { sanitizeLine, utf8ByteLength } from './text'

/** Hub-assigned ids are ULIDs; the schema accepts any short url-safe token so fixtures stay readable. */
export const IdSchema = z
  .string()
  .min(1)
  .max(MAX_ID_LENGTH)
  .regex(/^[A-Za-z0-9_-]+$/, 'ids are url-safe tokens')

/** Member names, handles and room names (§2). Failures map to `invalid_name`. */
export const NameSchema = z.string().refine(isValidName, {
  message: 'names must match ^[a-z0-9][a-z0-9_-]{0,31}$',
  params: { code: 'invalid_name' },
})

/** Unix ms. */
export const TimestampSchema = z.number().int().nonnegative()

export const SeqSchema = z.number().int().nonnegative()

/** Untrusted one-line text, sanitized on parse (§3: single line, ≤ maxChars characters). */
export const lineSchema = (maxChars: number) =>
  z
    .string()
    .max(MAX_RAW_LINE_CHARS)
    .transform((value) => sanitizeLine(value, maxChars))

/** Message text: at most 64 KiB of UTF-8. Failures map to `payload_too_large`. */
export const TextSchema = z.string().refine((value) => utf8ByteLength(value) <= MAX_TEXT_BYTES, {
  message: `text exceeds ${MAX_TEXT_BYTES} bytes`,
  params: { code: 'payload_too_large' },
})

/** UTF-8 size of `value` as JSON; values JSON can't encode count as oversized. */
function jsonBytes(value: unknown): number {
  try {
    return utf8ByteLength(JSON.stringify(value) ?? '')
  } catch {
    return Number.POSITIVE_INFINITY
  }
}

/** Free-form message metadata, at most 8 KiB as JSON. Failures map to `payload_too_large`. */
export const MetaSchema = z
  .record(z.string(), z.unknown())
  .refine((value) => jsonBytes(value) <= MAX_META_BYTES, {
    message: `meta exceeds ${MAX_META_BYTES} bytes`,
    params: { code: 'payload_too_large' },
  })

export const EmptySchema = z.object({})

/** Accepts a known enum value; anything else becomes `fallback` (forward compatibility, §11). */
export const lenientEnum = <const T extends readonly [string, ...string[]]>(values: T, fallback: T[number]) =>
  z
    .string()
    .max(64)
    .transform((value): T[number] => ((values as readonly string[]).includes(value) ? value : fallback))
