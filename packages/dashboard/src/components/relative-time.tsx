/** Relative time (DASHBOARD §8) with the full timestamp in a tooltip. */
import { cn } from '../lib/cn'
import { formatAgo, formatFullTimestamp, formatRelativeTime } from '../lib/format/time'
import { useNow } from '../lib/hooks/use-now'
import { Tooltip } from './ui/tooltip'

export interface RelativeTimeProps {
  readonly ts: number
  /** `relative` for lists (`今天 18:09`), `ago` for status lines (`25 秒前`). */
  readonly mode?: 'relative' | 'ago'
  /** Fixed "now" (tests, galleries); otherwise ticks every 30s. */
  readonly now?: number
  readonly className?: string
}

export function RelativeTime({ ts, mode = 'relative', now, className }: RelativeTimeProps) {
  const ticking = useNow()
  const at = now ?? ticking
  const text = mode === 'ago' ? formatAgo(ts, at) : formatRelativeTime(ts, at)
  const full = formatFullTimestamp(ts)
  // The tooltip opens on hover or a tap; screen readers get the full time right away.
  return (
    <Tooltip content={full}>
      <time dateTime={new Date(ts).toISOString()} className={cn('whitespace-nowrap', className)}>
        {text}
        <span className="sr-only">（{full}）</span>
      </time>
    </Tooltip>
  )
}
