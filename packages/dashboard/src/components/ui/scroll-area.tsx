/** Scroll area with a slim ink thumb (knock lists, long chip rows). */
import { ScrollArea as ScrollPrimitive } from 'radix-ui'
import type { ComponentProps } from 'react'
import { cn } from '../../lib/cn'

export interface ScrollAreaProps extends ComponentProps<typeof ScrollPrimitive.Root> {
  readonly orientation?: 'vertical' | 'horizontal'
  readonly viewportLabel?: string
}

export function ScrollArea({
  className,
  children,
  orientation = 'vertical',
  viewportLabel,
  ...props
}: ScrollAreaProps) {
  return (
    <ScrollPrimitive.Root className={cn('relative overflow-hidden', className)} {...props}>
      <ScrollPrimitive.Viewport
        aria-label={viewportLabel}
        tabIndex={viewportLabel === undefined ? undefined : 0}
        className="focus-ring size-full rounded-[inherit]"
      >
        {children}
      </ScrollPrimitive.Viewport>
      <ScrollPrimitive.Scrollbar
        orientation={orientation}
        className={cn(
          'flex touch-none select-none p-0.5',
          orientation === 'vertical' ? 'h-full w-2' : 'h-2 flex-col',
        )}
      >
        <ScrollPrimitive.Thumb className="relative flex-1 rounded-full bg-muted/40" />
      </ScrollPrimitive.Scrollbar>
      <ScrollPrimitive.Corner />
    </ScrollPrimitive.Root>
  )
}
