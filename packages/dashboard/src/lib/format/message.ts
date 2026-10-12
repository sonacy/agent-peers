/**
 * Message text as plain text (PROTOCOL §9: never HTML): fenced code blocks, http(s) links and the
 * long-answer collapse rule (DASHBOARD §4.4: collapse after 8 lines).
 */

export type Segment =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'code'; readonly text: string; readonly lang?: string }

const FENCE = /```([\w+-]*)[ \t]*\n?([\s\S]*?)(?:```|$)/g

/** Splits text on ``` fences; an unclosed fence runs to the end. Empty text segments are dropped. */
export function splitCodeBlocks(text: string): readonly Segment[] {
  const segments: Segment[] = []
  let last = 0
  for (const match of text.matchAll(FENCE)) {
    const start = match.index ?? 0
    if (start > last) segments.push({ kind: 'text', text: text.slice(last, start) })
    const lang = match[1] === undefined || match[1] === '' ? undefined : match[1]
    const body = (match[2] ?? '').replace(/\n$/, '')
    segments.push(lang === undefined ? { kind: 'code', text: body } : { kind: 'code', text: body, lang })
    last = start + match[0].length
  }
  if (last < text.length) segments.push({ kind: 'text', text: text.slice(last) })
  return segments.filter((s) => s.kind === 'code' || s.text.trim() !== '')
}

export type Inline = { readonly kind: 'text' | 'link' | 'code'; readonly text: string }

/** `inline code`: one backtick pair on a single line, at least one character inside. */
const INLINE_CODE = /`([^`\n]+)`/g

/**
 * Splits plain text into text, inline-code and link runs. Code spans are taken first (a URL inside
 * backticks stays code), then the text between them is linkified.
 */
export function inlineRuns(text: string): readonly Inline[] {
  const parts: Inline[] = []
  let last = 0
  for (const match of text.matchAll(INLINE_CODE)) {
    const start = match.index ?? 0
    if (start > last) parts.push(...linkify(text.slice(last, start)))
    parts.push({ kind: 'code', text: match[1] ?? '' })
    last = start + match[0].length
  }
  if (last < text.length) parts.push(...linkify(text.slice(last)))
  return parts
}

/** ASCII URL characters only, so CJK text and full-width punctuation end the link. */
const URL_RE = /https?:\/\/[A-Za-z0-9\-._~:/?#@!$&*+,;=%]+/g
const TRAILING_PUNCT = /[.,;:!?]+$/

/** Splits plain text into text and http(s) link runs (trailing punctuation stays text). */
export function linkify(text: string): readonly Inline[] {
  const parts: Inline[] = []
  let last = 0
  for (const match of text.matchAll(URL_RE)) {
    const start = match.index ?? 0
    const url = match[0].replace(TRAILING_PUNCT, '')
    if (start > last) parts.push({ kind: 'text', text: text.slice(last, start) })
    parts.push({ kind: 'link', text: url })
    last = start + url.length
  }
  if (last < text.length) parts.push({ kind: 'text', text: text.slice(last) })
  return parts
}

export const COLLAPSE_LINES = 8
/** Rough characters per rendered line in an answer bubble (CJK-heavy text at card width). */
export const CHARS_PER_LINE = 48

/** Estimated rendered lines: each source line wraps every CHARS_PER_LINE characters. */
export function estimateLines(text: string, charsPerLine: number = CHARS_PER_LINE): number {
  return text
    .split('\n')
    .reduce((sum, line) => sum + Math.max(1, Math.ceil(Array.from(line).length / charsPerLine)), 0)
}

export function shouldCollapse(text: string, maxLines: number = COLLAPSE_LINES): boolean {
  return estimateLines(text) > maxLines
}
