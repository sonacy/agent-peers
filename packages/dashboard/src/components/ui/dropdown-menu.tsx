/** Dropdown menu (card `⋯` menus, avatar menu). Items are 44px tall. */
import { Check, Circle } from 'lucide-react'
import { DropdownMenu as MenuPrimitive } from 'radix-ui'
import type { ComponentProps } from 'react'
import { cn } from '../../lib/cn'

export const DropdownMenu = MenuPrimitive.Root
export const DropdownMenuTrigger = MenuPrimitive.Trigger
export const DropdownMenuGroup = MenuPrimitive.Group
export const DropdownMenuRadioGroup = MenuPrimitive.RadioGroup

export function DropdownMenuContent({
  className,
  sideOffset = 6,
  align = 'end',
  ...props
}: ComponentProps<typeof MenuPrimitive.Content>) {
  return (
    <MenuPrimitive.Portal>
      <MenuPrimitive.Content
        sideOffset={sideOffset}
        align={align}
        className={cn(
          'z-50 min-w-44 rounded-2xl border-2 border-line bg-surface p-1.5 text-ink shadow-hard animate-pop-in',
          className,
        )}
        {...props}
      />
    </MenuPrimitive.Portal>
  )
}

const ITEM =
  'relative flex min-h-11 cursor-pointer select-none items-center gap-2 rounded-xl px-3 text-sm outline-none data-[disabled]:pointer-events-none data-[highlighted]:bg-surface-2 data-[disabled]:opacity-50 [&_svg]:size-4'

export interface DropdownMenuItemProps extends ComponentProps<typeof MenuPrimitive.Item> {
  readonly tone?: 'default' | 'danger'
}

export function DropdownMenuItem({ className, tone = 'default', ...props }: DropdownMenuItemProps) {
  return <MenuPrimitive.Item className={cn(ITEM, tone === 'danger' && 'text-danger', className)} {...props} />
}

export function DropdownMenuCheckboxItem({
  className,
  children,
  ...props
}: ComponentProps<typeof MenuPrimitive.CheckboxItem>) {
  return (
    <MenuPrimitive.CheckboxItem className={cn(ITEM, 'pr-9', className)} {...props}>
      {children}
      <MenuPrimitive.ItemIndicator className="absolute right-3">
        <Check />
      </MenuPrimitive.ItemIndicator>
    </MenuPrimitive.CheckboxItem>
  )
}

export function DropdownMenuRadioItem({
  className,
  children,
  ...props
}: ComponentProps<typeof MenuPrimitive.RadioItem>) {
  return (
    <MenuPrimitive.RadioItem className={cn(ITEM, 'pr-9', className)} {...props}>
      {children}
      <MenuPrimitive.ItemIndicator className="absolute right-3">
        <Circle className="fill-current" />
      </MenuPrimitive.ItemIndicator>
    </MenuPrimitive.RadioItem>
  )
}

export function DropdownMenuLabel({ className, ...props }: ComponentProps<typeof MenuPrimitive.Label>) {
  return <MenuPrimitive.Label className={cn('px-3 py-1.5 text-meta text-muted', className)} {...props} />
}

export function DropdownMenuSeparator({
  className,
  ...props
}: ComponentProps<typeof MenuPrimitive.Separator>) {
  return <MenuPrimitive.Separator className={cn('my-1 h-px bg-line/15', className)} {...props} />
}
