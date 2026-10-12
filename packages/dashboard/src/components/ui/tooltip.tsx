/** Tooltip: ink bubble used for full titles, model names and full timestamps. */
import { Tooltip as TooltipPrimitive } from 'radix-ui'
import { type ComponentProps, type MouseEvent, type ReactNode, useRef, useState } from 'react'
import { cn } from '../../lib/cn'

export const TooltipProvider = TooltipPrimitive.Provider
export const TooltipRoot = TooltipPrimitive.Root
export const TooltipTrigger = TooltipPrimitive.Trigger

export function TooltipContent({
  className,
  sideOffset = 6,
  children,
  ...props
}: ComponentProps<typeof TooltipPrimitive.Content>) {
  return (
    <TooltipPrimitive.Portal>
      <TooltipPrimitive.Content
        sideOffset={sideOffset}
        className={cn(
          'z-50 max-w-xs break-words rounded-lg bg-ink-fill px-2.5 py-1.5 text-meta text-on-ink shadow-chip animate-fade-in',
          className,
        )}
        {...props}
      >
        {children}
      </TooltipPrimitive.Content>
    </TooltipPrimitive.Portal>
  )
}

export interface TooltipProps {
  readonly content: ReactNode
  readonly children: ReactNode
  readonly side?: 'top' | 'right' | 'bottom' | 'left'
}

/** A tap on plain text toggles its tooltip; links and buttons keep their own click. */
function inControl(event: MouseEvent<HTMLElement>): boolean {
  return event.currentTarget.closest('a, button') !== null
}

/**
 * Shorthand: wraps a single focusable or text child (rendered asChild). Radix opens tooltips on
 * hover and focus only; a click or tap toggles it too, so touch screens can read the full text.
 */
export function Tooltip({ content, children, side }: TooltipProps) {
  const [open, setOpen] = useState(false)
  // Radix closes an open tooltip on pointerdown, before the click: remember what the tap saw.
  const openAtPress = useRef(false)
  const press = () => {
    openAtPress.current = open
  }
  const toggle = (event: MouseEvent<HTMLElement>) => {
    if (inControl(event)) return
    // Radix also closes the tooltip on click; preventDefault skips that so the tap decides.
    event.preventDefault()
    setOpen(!openAtPress.current)
  }
  return (
    <TooltipRoot open={open} onOpenChange={setOpen}>
      <TooltipTrigger asChild onPointerDown={press} onClick={toggle}>
        {children}
      </TooltipTrigger>
      <TooltipContent side={side}>{content}</TooltipContent>
    </TooltipRoot>
  )
}
