/** Button (DASHBOARD §3): rounded-xl, 2px ink border, 3px hard shadow that snaps away on press. */
import { cva, type VariantProps } from 'class-variance-authority'
import { Slot } from 'radix-ui'
import type { ComponentProps } from 'react'
import { cn } from '../../lib/cn'

export const buttonVariants = cva(
  [
    'press focus-ring relative inline-flex shrink-0 cursor-pointer select-none items-center justify-center gap-2',
    'whitespace-nowrap rounded-xl border-2 font-semibold',
    'disabled:cursor-not-allowed disabled:opacity-50 aria-disabled:cursor-not-allowed aria-disabled:opacity-50',
    '[&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0',
  ],
  {
    variants: {
      variant: {
        primary: 'border-line bg-primary text-on-primary shadow-btn hover:brightness-105',
        secondary: 'border-line bg-surface text-ink shadow-btn hover:bg-surface-2',
        lime: 'border-line bg-lime text-lime-ink shadow-btn hover:brightness-[1.03]',
        'danger-outline': 'border-danger bg-surface text-danger shadow-btn hover:bg-danger-soft',
        ghost: 'border-transparent bg-transparent text-ink shadow-none hover:bg-surface-2',
        // Quiet in a list of rows: muted text, outlined in danger only when its row (`group`) is
        // hovered or focused, so a table isn't a column of red buttons.
        'danger-ghost': [
          'border-transparent bg-transparent text-muted shadow-none',
          'hover:border-danger hover:bg-danger-soft hover:text-danger focus-visible:border-danger focus-visible:text-danger',
          'group-hover:border-danger group-hover:text-danger group-focus-within:border-danger group-focus-within:text-danger',
        ],
      },
      size: {
        // sm and icon-sm stay visually compact; the ::after box keeps the hit target at 44px (§9).
        sm: 'h-9 px-3 text-meta after:absolute after:-inset-1 after:content-[""]',
        md: 'min-h-11 px-4 text-sm',
        lg: 'min-h-12 px-5 text-base',
        icon: 'size-11 p-0',
        'icon-sm': 'size-9 p-0 after:absolute after:-inset-1 after:content-[""]',
      },
      block: { true: 'w-full', false: '' },
    },
    defaultVariants: { variant: 'secondary', size: 'md', block: false },
  },
)

export type ButtonVariantProps = VariantProps<typeof buttonVariants>

export interface ButtonProps extends ComponentProps<'button'>, ButtonVariantProps {
  /** Render the child element (e.g. a router link) with button styling. */
  readonly asChild?: boolean
}

export function Button({ className, variant, size, block, asChild = false, type, ...props }: ButtonProps) {
  const classes = cn(buttonVariants({ variant, size, block }), className)
  if (asChild) return <Slot.Root className={classes} {...props} />
  return <button type={type ?? 'button'} className={classes} {...props} />
}
