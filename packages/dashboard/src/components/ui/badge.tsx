/** Count badge (nav pills, knock counts). Caps at 99+ (DASHBOARD §8). */
import { cva, type VariantProps } from 'class-variance-authority'
import type { ComponentProps } from 'react'
import { cn } from '../../lib/cn'
import { formatCount } from '../../lib/format/count'

export const badgeVariants = cva(
  'inline-flex h-5 min-w-5 items-center justify-center rounded-full px-1.5 font-semibold text-[11px] leading-none tabular-nums',
  {
    variants: {
      tone: {
        primary: 'bg-primary text-on-primary',
        lime: 'bg-lime text-lime-ink',
        blush: 'bg-blush text-face-ink',
        ink: 'bg-active text-on-active',
      },
    },
    defaultVariants: { tone: 'primary' },
  },
)

export interface BadgeProps
  extends Omit<ComponentProps<'span'>, 'children'>,
    VariantProps<typeof badgeVariants> {
  readonly count: number
  /** Accessible text, e.g. `3 人在敲门`; defaults to the number. */
  readonly label?: string
  /** Render nothing for zero (the default). */
  readonly hideZero?: boolean
}

export function Badge({ count, label, hideZero = true, tone, className, ...props }: BadgeProps) {
  if (hideZero && count <= 0) return null
  const text = formatCount(count)
  return (
    <span className={cn(badgeVariants({ tone }), className)} {...props}>
      <span aria-hidden="true">{text}</span>
      <span className="sr-only">{label ?? text}</span>
    </span>
  )
}
