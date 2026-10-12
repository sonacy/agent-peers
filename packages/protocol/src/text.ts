/** Pure text helpers shared by the schemas, the envelope and the join prompt. */
import { MAX_LINE_CHARS } from './constants'

const ELLIPSIS = '…'
/** Control characters (C0, DEL, C1) and line/paragraph separators: replaced by a space. */
const BREAKING = /[\p{Cc}\u2028\u2029]/gu
/** Bidi overrides/isolates/marks and zero-width characters: removed, so text can't be visually forged. */
const INVISIBLE = /[\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff\u061c]/g
const SPACES = /\s+/g

/** UTF-8 byte length without allocating (lone surrogates count 3 bytes, as TextEncoder emits U+FFFD). */
export function utf8ByteLength(text: string): number {
  let bytes = 0
  for (let i = 0; i < text.length; i += 1) {
    const unit = text.charCodeAt(i)
    if (unit < 0x80) bytes += 1
    else if (unit < 0x800) bytes += 2
    else if (isHighSurrogate(unit) && isLowSurrogate(text.charCodeAt(i + 1))) {
      bytes += 4
      i += 1
    } else bytes += 3
  }
  return bytes
}

function isHighSurrogate(unit: number): boolean {
  return unit >= 0xd800 && unit <= 0xdbff
}

function isLowSurrogate(unit: number): boolean {
  return unit >= 0xdc00 && unit <= 0xdfff
}

/** Number of Unicode code points (what the spec calls "characters"). */
export function charCount(text: string): number {
  let count = 0
  for (const _ of text) count += 1
  return count
}

/** Cuts to at most `maxChars` code points, ending in `…` when anything was removed. */
export function truncateChars(text: string, maxChars: number): string {
  if (maxChars <= 0) return ''
  const chars = Array.from(text)
  if (chars.length <= maxChars) return text
  return `${chars.slice(0, maxChars - 1).join('')}${ELLIPSIS}`
}

/** Cuts to at most `maxUnits` UTF-16 code units without splitting a surrogate pair. */
export function truncateUnits(text: string, maxUnits: number): string {
  if (text.length <= maxUnits) return text
  if (maxUnits <= 0) return ''
  const end = isHighSurrogate(text.charCodeAt(maxUnits - 1)) ? maxUnits - 1 : maxUnits
  return text.slice(0, end)
}

/**
 * Reduces untrusted text to one display line (§3 free-text fields, §10.2 knock notes):
 * NFC-normalized, control and line-break characters become spaces, bidi/zero-width characters are
 * dropped, whitespace is collapsed and trimmed, and the result is cut to `maxChars` code points.
 */
export function sanitizeLine(input: string, maxChars: number = MAX_LINE_CHARS): string {
  const line = input
    .normalize('NFC')
    .replace(INVISIBLE, '')
    .replace(BREAKING, ' ')
    .replace(SPACES, ' ')
    .trim()
  return truncateChars(line, maxChars)
}

/** Normalizes CRLF, lone CR and Unicode line separators to `\n`. */
export function normalizeNewlines(text: string): string {
  return text.replace(/\r\n?|[\u2028\u2029\u0085]/g, '\n')
}
