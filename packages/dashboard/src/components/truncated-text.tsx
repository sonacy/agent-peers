/**
 * Truncation (DASHBOARD §8): titles clamp to 1–2 lines with the full text in a tooltip or title
 * attribute; `middle` shortens long usernames keeping both ends.
 */
import { type ElementType, useRef } from 'react'
import { cn } from '../lib/cn'
import { truncateMiddle } from '../lib/format/text'
import { useOverflow } from '../lib/hooks/use-overflow'
import { Tooltip } from './ui/tooltip'

export interface TruncatedTextProps {
  readonly text: string
  readonly lines?: 1 | 2
  /** Shorten to this many characters in the middle instead of clamping at the end. */
  readonly middle?: number
  /** Show the full text in a tooltip (titles, models) rather than a native title attribute. */
  readonly tooltip?: boolean
  readonly as?: ElementType
  readonly className?: string
}

export function TruncatedText(props: TruncatedTextProps) {
  return props.tooltip ? <TooltipText {...props} /> : <TitledText {...props} />
}

function classesFor(lines: 1 | 2, className: string | undefined): string {
  return cn('min-w-0 break-words', lines === 1 ? 'block truncate' : 'line-clamp-2', className)
}

function TitledText({ text, lines = 1, middle, as, className }: TruncatedTextProps) {
  const Tag: ElementType = as ?? 'span'
  const shown = middle === undefined ? text : truncateMiddle(text, middle)
  return (
    <Tag className={classesFor(lines, className)} title={text} aria-label={shown !== text ? text : undefined}>
      {shown}
    </Tag>
  )
}

/**
 * The full text in a tooltip. When the text is actually cut off it becomes a tab stop, so keyboard
 * users can open the tooltip on focus; a tap toggles it on touch screens.
 */
function TooltipText({ text, lines = 1, middle, as, className }: TruncatedTextProps) {
  const Tag: ElementType = as ?? 'span'
  const ref = useRef<HTMLElement>(null)
  const shown = middle === undefined ? text : truncateMiddle(text, middle)
  const overflowing = useOverflow(ref, shown)
  const clipped = shown !== text || overflowing
  return (
    <Tooltip content={text}>
      <Tag
        ref={ref}
        // A clipped title must be reachable to read it in full (WCAG 2.1.1).
        tabIndex={clipped ? 0 : undefined}
        className={cn(classesFor(lines, className), clipped && 'focus-ring rounded-sm')}
        aria-label={shown !== text ? text : undefined}
      >
        {shown}
      </Tag>
    </Tooltip>
  )
}
