/** Text truncation helpers (DASHBOARD §8). CSS line clamping handles most titles; these cover the rest. */

const ELLIPSIS = '…'

/** Keeps the start: `an.extremely.long.a…`. Counts code points so emoji and CJK aren't split. */
export function truncateEnd(text: string, max: number): string {
  const chars = Array.from(text)
  if (max <= 0) return ''
  if (chars.length <= max) return text
  return chars.slice(0, Math.max(1, max - 1)).join('') + ELLIPSIS
}

/** Keeps both ends: `a.very.lo…example.com`, for usernames and hosts where the tail matters. */
export function truncateMiddle(text: string, max: number): string {
  const chars = Array.from(text)
  if (max <= 0) return ''
  if (chars.length <= max) return text
  if (max <= 2) return truncateEnd(text, max)
  const keep = max - 1
  const head = Math.ceil(keep / 2)
  const tail = keep - head
  return chars.slice(0, head).join('') + ELLIPSIS + chars.slice(chars.length - tail).join('')
}

/** The first letter for an avatar circle, uppercased; `?` for empty names. */
export function initialOf(name: string): string {
  const first = Array.from(name.trim())[0]
  return first === undefined ? '?' : first.toUpperCase()
}
