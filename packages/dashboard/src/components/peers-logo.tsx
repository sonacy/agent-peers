/** The Peers mark: two overlapping squares, the front one a face. */
import { cn } from '../lib/cn'

export function PeersLogo({
  withWord = true,
  className,
}: {
  readonly withWord?: boolean
  readonly className?: string
}) {
  return (
    <span className={cn('inline-flex items-center gap-2', className)}>
      <svg viewBox="0 0 32 32" className="size-8 shrink-0" aria-hidden="true" focusable="false">
        <rect
          x="2"
          y="7"
          width="20"
          height="20"
          rx="6"
          fill="var(--primary)"
          stroke="var(--line)"
          strokeWidth="2"
        />
        <rect
          x="10"
          y="4"
          width="20"
          height="20"
          rx="6"
          fill="var(--lime)"
          stroke="var(--line)"
          strokeWidth="2"
        />
        <rect x="15.5" y="11" width="2.6" height="5" rx="1.3" fill="var(--face-ink)" />
        <rect x="21.5" y="11" width="2.6" height="5" rx="1.3" fill="var(--face-ink)" />
      </svg>
      {withWord ? <span className="font-display text-xl font-extrabold tracking-tight">Peers</span> : null}
    </span>
  )
}
