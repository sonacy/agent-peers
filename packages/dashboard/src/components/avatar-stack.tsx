/**
 * Overlapping faces (max 4 by default) with a separate `+N` chip (DASHBOARD §4.2, §4.3). Faces are
 * 22px, overlap by 6px and wear a 2px surface ring so each face's eyes stay readable.
 */
import { cn } from '../lib/cn'
import { formatOverflow } from '../lib/format/count'
import { AgentFace, type Expression } from './agent-face'
import { MemberAvatar } from './member-avatar'

export interface StackItem {
  readonly id: string
  readonly kind?: 'agent' | 'member'
  /** Member name (for the initial); unused for agents. */
  readonly name?: string
  readonly expression?: Expression
}

export interface AvatarStackProps {
  readonly items: readonly StackItem[]
  /** Accessible summary, e.g. `5 个 agent`. */
  readonly label: string
  readonly max?: number
  /** Total when only a page of items is loaded (`+N` counts against it). */
  readonly total?: number
  readonly className?: string
}

export function AvatarStack({ items, label, max = 4, total, className }: AvatarStackProps) {
  const shown = items.slice(0, Math.max(0, max))
  const hidden = Math.max(0, (total ?? items.length) - shown.length)
  return (
    <span role="img" aria-label={label} className={cn('inline-flex items-center', className)}>
      {shown.map((item, index) => (
        <span
          key={item.id}
          data-stack-item="true"
          className={cn(
            'inline-flex ring-2 ring-surface',
            item.kind === 'member' ? 'rounded-full' : 'rounded-md',
            index > 0 && '-ml-1.5',
          )}
        >
          {item.kind === 'member' ? (
            <MemberAvatar memberId={item.id} name={item.name ?? '?'} size={22} decorative />
          ) : (
            <AgentFace id={item.id} size={22} expression={item.expression ?? 'idle'} />
          )}
        </span>
      ))}
      {hidden > 0 ? (
        <span
          aria-hidden="true"
          data-stack-overflow="true"
          className="ml-1 inline-flex h-[22px] min-w-[22px] items-center justify-center rounded-full border-[1.5px] border-line bg-surface px-1.5 font-semibold text-[10px] text-ink tabular-nums"
        >
          {formatOverflow(hidden)}
        </span>
      ) : null}
    </span>
  )
}
