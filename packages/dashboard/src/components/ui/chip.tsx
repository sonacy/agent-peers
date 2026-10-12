/** Chips and pills (DASHBOARD §3): fully rounded, 1.5px border. FilterChip is the toggleable form. */
import { cva, type VariantProps } from 'class-variance-authority'
import type { ComponentProps } from 'react'
import { cn } from '../../lib/cn'

export const chipVariants = cva(
  'inline-flex max-w-full items-center gap-1 whitespace-nowrap rounded-full border-[1.5px] font-medium [&_svg]:size-3.5 [&_svg]:shrink-0',
  {
    variants: {
      tone: {
        outline: 'border-line bg-surface text-ink',
        violet: 'border-transparent bg-primary-tint text-primary-ink',
        lime: 'border-line bg-lime text-lime-ink',
        ink: 'border-line bg-active text-on-active',
        blush: 'border-transparent bg-blush-soft text-danger',
        warn: 'border-transparent bg-warn text-warn-ink',
        muted: 'border-transparent bg-surface-2 text-muted',
      },
      size: {
        sm: 'h-6 px-2 text-meta',
        md: 'h-8 px-3 text-sm',
      },
    },
    defaultVariants: { tone: 'outline', size: 'sm' },
  },
)

export interface ChipProps extends ComponentProps<'span'>, VariantProps<typeof chipVariants> {}

export function Chip({ className, tone, size, ...props }: ChipProps) {
  return <span className={cn(chipVariants({ tone, size }), className)} {...props} />
}

export interface FilterChipProps extends ComponentProps<'button'> {
  readonly selected: boolean
}

/** A pressed-state pill button (filter rows): ink when selected, outlined otherwise. 44px hit area. */
export function FilterChip({ selected, className, type, ...props }: FilterChipProps) {
  return (
    <button
      type={type ?? 'button'}
      aria-pressed={selected}
      className={cn(
        chipVariants({ tone: selected ? 'ink' : 'outline', size: 'md' }),
        'focus-ring relative shrink-0 cursor-pointer border-2 after:absolute after:-inset-1.5 after:content-[""]',
        !selected && 'hover:bg-surface-2',
        className,
      )}
      {...props}
    />
  )
}
