/**
 * Message body (DASHBOARD §4.4): plain text with wrapped links and dark mono code blocks that scroll
 * sideways; long answers collapse after 8 lines behind 展开全文.
 */
import { useEffect, useId, useRef, useState } from 'react'
import { cn } from '../../lib/cn'
import {
  type Inline,
  inlineRuns,
  type Segment,
  shouldCollapse,
  splitCodeBlocks,
} from '../../lib/format/message'

function Run({ part }: { readonly part: Inline }) {
  if (part.kind === 'link') {
    return (
      <a
        href={part.text}
        target="_blank"
        rel="noopener noreferrer"
        className="focus-ring break-all rounded-sm underline decoration-2 underline-offset-2"
      >
        {part.text}
      </a>
    )
  }
  if (part.kind === 'code') {
    // bg-current/10 follows the bubble's text color: ink/10 on grey, lime-ink/10 on lime.
    return (
      <code className="rounded-md bg-current/10 px-1 py-px font-mono text-[0.9em] [overflow-wrap:anywhere]">
        {part.text}
      </code>
    )
  }
  return <span>{part.text}</span>
}

/** Inline runs only (code spans, links), for the clamped one-paragraph previews. */
export function InlineText({ text }: { readonly text: string }) {
  return (
    <>
      {inlineRuns(text).map((part, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: runs are positional and never reorder
        <Run key={i} part={part} />
      ))}
    </>
  )
}

function TextRun({ text }: { readonly text: string }) {
  return (
    <p className="whitespace-pre-wrap break-words [overflow-wrap:anywhere]">
      {inlineRuns(text.replace(/^\n+|\n+$/g, '')).map((part, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: runs are positional and never reorder
        <Run key={i} part={part} />
      ))}
    </p>
  )
}

function CodeBlock({ segment }: { readonly segment: Extract<Segment, { kind: 'code' }> }) {
  return (
    <pre
      data-lang={segment.lang}
      // biome-ignore lint/a11y/noNoninteractiveTabindex: a horizontally scrolling block must be reachable by keyboard (WCAG 2.1.1)
      tabIndex={0}
      className="focus-ring max-w-full overflow-x-auto rounded-xl border-2 border-line bg-ink-fill px-3 py-2 font-mono text-[12.5px] text-on-ink leading-relaxed"
    >
      <code>{segment.text}</code>
    </pre>
  )
}

export function MessageBody({ text, className }: { readonly text: string; readonly className?: string }) {
  return (
    <div className={cn('flex min-w-0 flex-col gap-2', className)}>
      {splitCodeBlocks(text).map((segment, i) =>
        segment.kind === 'code' ? (
          // biome-ignore lint/suspicious/noArrayIndexKey: segments are positional and never reorder
          <CodeBlock key={i} segment={segment} />
        ) : (
          // biome-ignore lint/suspicious/noArrayIndexKey: segments are positional and never reorder
          <TextRun key={i} text={segment.text} />
        ),
      )}
    </div>
  )
}

/** Characters of the collapsed answer read to screen readers before 展开全文. */
export const PREVIEW_CHARS = 120

/** The start of a collapsed answer as plain text, for screen readers. */
export function previewText(text: string, max: number = PREVIEW_CHARS): string {
  const flat = text
    .replace(/```[^\n]*\n?/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  const chars = Array.from(flat)
  return chars.length <= max ? flat : `${chars.slice(0, max).join('')}…`
}

/**
 * The body, clipped to about 8 lines with a 展开全文 / 收起 toggle when it is long. While collapsed
 * the clipped body is `inert`, so links and code blocks below the cut can't take focus out of
 * sight; screen readers get the start as plain text and 展开全文. Expanding moves focus into it.
 */
export function CollapsibleMessage({
  text,
  className,
}: {
  readonly text: string
  readonly className?: string
}) {
  const [open, setOpen] = useState(false)
  const id = useId()
  const body = useRef<HTMLDivElement>(null)
  const toggled = useRef(false)
  useEffect(() => {
    if (open && toggled.current) body.current?.focus()
  }, [open])
  if (!shouldCollapse(text)) return <MessageBody text={text} className={className} />
  return (
    <div className="flex flex-col items-start gap-2">
      {open ? null : (
        <p data-preview="" className="sr-only">
          {previewText(text)}
        </p>
      )}
      <div
        id={id}
        ref={body}
        tabIndex={-1}
        inert={!open}
        className={cn('relative w-full outline-none', !open && 'max-h-[12em] overflow-hidden')}
      >
        <MessageBody text={text} className={className} />
        {open ? null : (
          <div
            aria-hidden="true"
            className="absolute inset-x-0 bottom-0 h-10 bg-gradient-to-t from-lime to-transparent"
          />
        )}
      </div>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => {
          toggled.current = true
          setOpen((value) => !value)
        }}
        className="press focus-ring relative inline-flex h-8 cursor-pointer items-center rounded-lg border-2 border-line bg-surface px-3 font-semibold text-ink text-meta shadow-chip after:absolute after:-inset-1.5 after:content-['']"
      >
        {open ? '收起' : '展开全文'}
      </button>
    </div>
  )
}
