/** Search-match highlighting (找房间: matching text in lime). Plain text in, React nodes out. */
import { Fragment } from 'react'

export interface Part {
  readonly text: string
  readonly hit: boolean
}

/** Splits `text` around case-insensitive matches of `query`; one non-hit part when nothing matches. */
export function splitHighlight(text: string, query: string): readonly Part[] {
  const q = query.trim().toLowerCase()
  if (q === '') return [{ text, hit: false }]
  const lower = text.toLowerCase()
  const parts: Part[] = []
  let from = 0
  for (let at = lower.indexOf(q); at !== -1; at = lower.indexOf(q, at + q.length)) {
    if (at > from) parts.push({ text: text.slice(from, at), hit: false })
    parts.push({ text: text.slice(at, at + q.length), hit: true })
    from = at + q.length
  }
  if (from < text.length) parts.push({ text: text.slice(from), hit: false })
  return parts
}

export function Highlight({ text, query }: { readonly text: string; readonly query: string }) {
  return (
    <>
      {splitHighlight(text, query).map((part, index) =>
        part.hit ? (
          // biome-ignore lint/suspicious/noArrayIndexKey: parts are positional and never reorder
          <mark key={index} className="rounded-sm bg-lime px-0.5 text-lime-ink">
            {part.text}
          </mark>
        ) : (
          // biome-ignore lint/suspicious/noArrayIndexKey: parts are positional and never reorder
          <Fragment key={index}>{part.text}</Fragment>
        ),
      )}
    </>
  )
}
