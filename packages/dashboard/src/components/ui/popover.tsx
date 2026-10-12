/** Popover and hover card: white card with ink outline and hard shadow. */
import { HoverCard as HoverCardPrimitive, Popover as PopoverPrimitive } from 'radix-ui'
import type { ComponentProps } from 'react'
import { cn } from '../../lib/cn'

const PANEL =
  'z-50 w-72 rounded-2xl border-2 border-line bg-surface p-4 text-ink shadow-hard animate-pop-in outline-none'

export const Popover = PopoverPrimitive.Root
export const PopoverTrigger = PopoverPrimitive.Trigger
export const PopoverClose = PopoverPrimitive.Close

export function PopoverContent({
  className,
  sideOffset = 8,
  align = 'center',
  ...props
}: ComponentProps<typeof PopoverPrimitive.Content>) {
  return (
    <PopoverPrimitive.Portal>
      <PopoverPrimitive.Content
        sideOffset={sideOffset}
        align={align}
        className={cn(PANEL, className)}
        {...props}
      />
    </PopoverPrimitive.Portal>
  )
}

export const HoverCard = HoverCardPrimitive.Root
export const HoverCardTrigger = HoverCardPrimitive.Trigger

export function HoverCardContent({
  className,
  sideOffset = 8,
  align = 'end',
  ...props
}: ComponentProps<typeof HoverCardPrimitive.Content>) {
  return (
    <HoverCardPrimitive.Portal>
      <HoverCardPrimitive.Content
        sideOffset={sideOffset}
        align={align}
        className={cn(PANEL, className)}
        {...props}
      />
    </HoverCardPrimitive.Portal>
  )
}
