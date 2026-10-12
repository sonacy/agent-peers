/** Empty states (DASHBOARD §5): dashed card, art, a title that says what's missing and what to do. */
import type { ReactNode } from 'react'
import { cn } from '../lib/cn'
import { AgentFace } from './agent-face'
import { RoomDoor } from './room-door'
import { Button } from './ui/button'
import { InlineCode } from './ui/input'

export interface EmptyStateProps {
  readonly art?: ReactNode
  readonly title: string
  readonly description?: ReactNode
  /** Actions or a command snippet under the description. */
  readonly children?: ReactNode
  readonly className?: string
}

export function EmptyState({ art, title, description, children, className }: EmptyStateProps) {
  return (
    <section
      aria-label={title}
      className={cn(
        'flex flex-col items-center gap-3 rounded-2xl border-2 border-dashed border-muted/40 bg-surface px-6 py-8 text-center',
        className,
      )}
    >
      {art === undefined ? null : <div aria-hidden="true">{art}</div>}
      <h3 className="font-display text-base font-bold">{title}</h3>
      {description === undefined ? null : <p className="max-w-sm text-muted text-sm">{description}</p>}
      {children === undefined ? null : (
        <div className="flex flex-wrap items-center justify-center gap-2">{children}</div>
      )}
    </section>
  )
}

export function NoAgentsEmpty({ className }: { readonly className?: string }) {
  return (
    <EmptyState
      className={className}
      art={<AgentFace id="sleeping" size={44} expression="offline" className="bg-face-cloud" />}
      title="还没有 agent 进房间"
      description="没进房间的对话不会上报，这里只显示进过房间的。在任意对话里说："
    >
      <InlineCode className="px-3 py-1.5 text-sm">/peers:room new 名字</InlineCode>
    </EmptyState>
  )
}

export interface NoRoomsEmptyProps {
  readonly onCreate: () => void
  readonly onFind: () => void
  readonly className?: string
}

export function NoRoomsEmpty({ onCreate, onFind, className }: NoRoomsEmptyProps) {
  return (
    <EmptyState
      className={className}
      art={<RoomDoor roomId="empty-room" size={44} />}
      title="一个房间都还没有"
      description="自己开一个，或者找同事的房间敲门。"
    >
      <Button variant="primary" size="sm" onClick={onCreate}>
        新建房间
      </Button>
      <Button size="sm" onClick={onFind}>
        找房间
      </Button>
    </EmptyState>
  )
}

export function NoAsksEmpty({ className }: { readonly className?: string }) {
  return (
    <EmptyState
      className={className}
      art={
        <span className="inline-flex gap-2">
          <AgentFace id="pair-left" size={44} />
          <AgentFace id="pair-right-2" size={44} />
        </span>
      }
      title="它们还没说过话"
      description={
        <>
          在 agent 里输入 <InlineCode>/peers:ask</InlineCode>，第一个问同房间的 agent 问问题。
        </>
      }
    />
  )
}
