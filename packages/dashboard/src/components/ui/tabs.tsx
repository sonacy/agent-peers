/** Tabs (room detail on phones: 成员 / 邀请 / 敲门) styled as a segmented ink control. */
import { Tabs as TabsPrimitive } from 'radix-ui'
import type { ComponentProps } from 'react'
import { cn } from '../../lib/cn'

export const Tabs = TabsPrimitive.Root
export const TabsContent = TabsPrimitive.Content

const LIST =
  'inline-flex w-full items-center gap-1 rounded-2xl border-2 border-line bg-surface p-1 shadow-btn sm:w-auto'
// Active: the --active pill (ink in light, inverted in dark). Inactive items carry a 1.5px outline in
// dark so they read as pills too. The focus ring is keyboard-only (focus-visible) and sits inside the
// active pill, so a tapped tab never looks doubled.
const ITEM = [
  'inline-flex min-h-11 flex-1 cursor-pointer items-center justify-center gap-1.5 whitespace-nowrap rounded-xl px-4',
  'border-[1.5px] border-transparent text-sm font-semibold text-muted transition-colors hover:text-ink',
  'focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-primary focus-visible:outline-offset-2',
  'data-[state=active]:bg-active data-[state=active]:text-on-active data-[state=active]:focus-visible:outline-offset-[-5px] data-[state=active]:focus-visible:outline-on-active',
  'aria-checked:bg-active aria-checked:text-on-active aria-checked:focus-visible:outline-offset-[-5px] aria-checked:focus-visible:outline-on-active',
  'dark:data-[state=inactive]:border-line dark:aria-[checked=false]:border-line',
].join(' ')

export function TabsList({ className, ...props }: ComponentProps<typeof TabsPrimitive.List>) {
  return <TabsPrimitive.List className={cn(LIST, className)} {...props} />
}

export function TabsTrigger({ className, ...props }: ComponentProps<typeof TabsPrimitive.Trigger>) {
  return <TabsPrimitive.Trigger className={cn(ITEM, className)} {...props} />
}

export const segmentedListClass = LIST
export const segmentedItemClass = ITEM
