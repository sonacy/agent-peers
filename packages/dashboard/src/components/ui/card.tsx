/** Card (DASHBOARD §3): rounded-2xl, 2px ink outline, 4px hard offset shadow, no blur. */
import { cva, type VariantProps } from 'class-variance-authority'
import type { ComponentProps } from 'react'
import { cn } from '../../lib/cn'

export const cardVariants = cva('rounded-2xl border-2 text-ink', {
  variants: {
    tone: {
      surface: 'border-line bg-surface',
      ink: 'border-line bg-ink-fill text-on-ink',
      lime: 'border-line bg-lime text-lime-ink',
      violet: 'border-line bg-primary-soft',
      blush: 'border-line bg-blush-soft',
      muted: 'border-line bg-surface-2',
      dashed: 'border-dashed border-muted/50 bg-surface',
    },
    elevation: { flat: 'shadow-none', raised: 'shadow-hard' },
  },
  defaultVariants: { tone: 'surface', elevation: 'raised' },
})

export interface CardProps extends ComponentProps<'div'>, VariantProps<typeof cardVariants> {}

export function Card({ className, tone, elevation, ...props }: CardProps) {
  return <div className={cn(cardVariants({ tone, elevation }), className)} {...props} />
}

export function CardHeader({ className, ...props }: ComponentProps<'div'>) {
  return <div className={cn('flex items-start gap-3 p-4 pb-2', className)} {...props} />
}

export function CardTitle({ className, ...props }: ComponentProps<'h3'>) {
  return <h3 className={cn('font-sans text-card font-semibold', className)} {...props} />
}

export function CardContent({ className, ...props }: ComponentProps<'div'>) {
  return <div className={cn('px-4 pb-4', className)} {...props} />
}

/** Footer separated by a dotted divider (the AgentCard "接受提问" row). */
export function CardFooter({ className, ...props }: ComponentProps<'div'>) {
  return (
    <div className={cn('divider-dotted mx-4 flex items-center justify-between py-3', className)} {...props} />
  )
}
