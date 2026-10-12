/** Reachability hint (DASHBOARD §6): warn-colored box under an agent card's status line. */
import { Clock3 } from 'lucide-react'
import type { ReactNode } from 'react'
import { reachabilityHint } from '../lib/agent'
import { cn } from '../lib/cn'

type HintCard = Parameters<typeof reachabilityHint>[0]

export interface ReachabilityHintProps {
  readonly card: HintCard
  readonly className?: string
}

export function ReachabilityHint({ card, className }: ReachabilityHintProps) {
  const text = reachabilityHint(card)
  if (text === undefined) return null
  return <WarnBox className={className}>{text}</WarnBox>
}

export interface WarnBoxProps {
  readonly children: ReactNode
  readonly icon?: ReactNode
  readonly className?: string
}

/** The warn box shared by reachability hints, the boundary reminder and the localhost warning. */
export function WarnBox({ children, icon, className }: WarnBoxProps) {
  return (
    <p className={cn('flex gap-2 rounded-xl bg-warn px-3 py-2 text-meta text-warn-ink', className)}>
      <span aria-hidden="true" className="mt-0.5 shrink-0 [&_svg]:size-3.5">
        {icon ?? <Clock3 />}
      </span>
      <span>{children}</span>
    </p>
  )
}
