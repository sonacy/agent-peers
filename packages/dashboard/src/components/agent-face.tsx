/**
 * The face avatar (DASHBOARD §3): a rounded square in the agent's hashed pastel, 2px ink outline and
 * two eyes. Expression carries status so it is never color-only.
 */
import { cn } from '../lib/cn'
import { FACE_BG, faceColor } from '../lib/hash'

export const FACE_SIZES = [64, 44, 28, 22] as const
export type FaceSize = (typeof FACE_SIZES)[number]

export const EXPRESSIONS = ['idle', 'busy', 'offline', 'awaiting'] as const
export type Expression = (typeof EXPRESSIONS)[number]

const SIZE: Readonly<Record<FaceSize, string>> = {
  64: 'size-16 rounded-2xl border-2',
  44: 'size-11 rounded-xl border-2',
  28: 'size-7 rounded-lg border-[1.5px]',
  22: 'size-[22px] rounded-md border-[1.5px]',
}

const EXPRESSION_LABEL: Readonly<Record<Expression, string>> = {
  idle: '有空',
  busy: '正在忙',
  offline: '离线',
  awaiting: '等你确认',
}

function Eyes({ expression }: { readonly expression: Expression }) {
  if (expression === 'offline') {
    return (
      <g data-eyes="closed" strokeLinecap="round" strokeWidth="2.6" stroke="currentColor" fill="none">
        <path d="M12 21.5q2.5 2 5 0" />
        <path d="M23 21.5q2.5 2 5 0" />
      </g>
    )
  }
  if (expression === 'busy') {
    // Looking sideways: short pupils pushed to the right edge of each eye.
    return (
      <g data-eyes="sideways" fill="currentColor">
        <rect x="17" y="16.5" width="4.5" height="5.5" rx="2.25" />
        <rect x="27" y="16.5" width="4.5" height="5.5" rx="2.25" />
      </g>
    )
  }
  return (
    <g data-eyes="open" fill="currentColor">
      <rect x="13" y="15" width="4" height="8" rx="2" />
      <rect x="23" y="15" width="4" height="8" rx="2" />
      {expression === 'awaiting' ? (
        <path
          data-brow="raised"
          d="M22.5 11.5 28 9"
          stroke="currentColor"
          strokeWidth="2.4"
          strokeLinecap="round"
          fill="none"
        />
      ) : null}
    </g>
  )
}

export interface AgentFaceProps {
  /** `agent_session_id`: picks the color, so one agent looks the same everywhere. */
  readonly id: string
  readonly size?: FaceSize
  readonly expression?: Expression
  /** Accessible name (e.g. the session title). Omit when a visible label sits next to the face. */
  readonly label?: string
  readonly mouth?: boolean
  readonly className?: string
}

export function AgentFace({
  id,
  size = 44,
  expression = 'idle',
  label,
  mouth = false,
  className,
}: AgentFaceProps) {
  const color = faceColor(id)
  const a11y =
    label === undefined
      ? { 'aria-hidden': true as const }
      : { role: 'img' as const, 'aria-label': `${label}（${EXPRESSION_LABEL[expression]}）` }
  return (
    <span
      data-face-color={color}
      data-expression={expression}
      className={cn(
        'relative inline-flex shrink-0 items-center justify-center border-line text-face-ink',
        SIZE[size],
        FACE_BG[color],
        expression === 'offline' && 'saturate-50',
        className,
      )}
      {...a11y}
    >
      <svg viewBox="0 0 40 40" className="size-full" aria-hidden="true" focusable="false">
        <Eyes expression={expression} />
        {mouth && expression !== 'offline' ? (
          <path
            d="M17 28q3 2.5 6 0"
            stroke="currentColor"
            strokeWidth="2.2"
            strokeLinecap="round"
            fill="none"
          />
        ) : null}
      </svg>
    </span>
  )
}
