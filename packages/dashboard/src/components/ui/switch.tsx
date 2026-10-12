/** Switch (接受提问, 能被找到): violet track with an ink outline. */
import { Switch as SwitchPrimitive } from 'radix-ui'
import type { ComponentProps } from 'react'
import { cn } from '../../lib/cn'

export function Switch({ className, ...props }: ComponentProps<typeof SwitchPrimitive.Root>) {
  return (
    <SwitchPrimitive.Root
      className={cn(
        'focus-ring relative inline-flex h-7 w-12 shrink-0 cursor-pointer items-center rounded-full border-2 border-line',
        'bg-surface-2 transition-colors data-[state=checked]:bg-primary',
        'disabled:cursor-not-allowed disabled:opacity-50',
        'after:absolute after:-inset-2 after:content-[""]',
        className,
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb
        className={cn(
          'pointer-events-none block size-5 rounded-full border-2 border-line bg-surface shadow-none',
          'translate-x-0.5 transition-transform data-[state=checked]:translate-x-[1.375rem]',
        )}
      />
    </SwitchPrimitive.Root>
  )
}
