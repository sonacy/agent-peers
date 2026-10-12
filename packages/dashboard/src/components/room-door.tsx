/** The room glyph (DASHBOARD §3): a tall rounded door with a knob, in the room's hashed color. */
import { cn } from '../lib/cn'
import { FACE_VAR, faceColor } from '../lib/hash'

export const DOOR_SIZES = [64, 44, 28, 22] as const
export type DoorSize = (typeof DOOR_SIZES)[number]

const SIZE: Readonly<Record<DoorSize, string>> = {
  64: 'h-16 w-[52px]',
  44: 'h-11 w-9',
  28: 'h-7 w-[23px]',
  22: 'h-[22px] w-[18px]',
}

export interface RoomDoorProps {
  readonly roomId: string
  readonly size?: DoorSize
  /** The hero door has eyes (room detail); list doors only a knob. */
  readonly face?: boolean
  /**
   * On the violet hero band: a surface-filled door with the hashed color as an inner panel, so a
   * violet room's door never melts into the band.
   */
  readonly onBand?: boolean
  readonly label?: string
  readonly className?: string
}

const DOOR_PATH = 'M5 40V11A9 9 0 0 1 14 2h6a9 9 0 0 1 9 9v29Z'
const PANEL_PATH = 'M9.5 36V12.5A5.5 5.5 0 0 1 15 7h4a5.5 5.5 0 0 1 5.5 5.5V36Z'

export function RoomDoor({
  roomId,
  size = 44,
  face = false,
  onBand = false,
  label,
  className,
}: RoomDoorProps) {
  const color = faceColor(roomId)
  const a11y =
    label === undefined ? { 'aria-hidden': true as const } : { role: 'img' as const, 'aria-label': label }
  return (
    <span data-face-color={color} className={cn('inline-flex shrink-0', SIZE[size], className)} {...a11y}>
      <svg viewBox="0 0 34 42" className="size-full overflow-visible" aria-hidden="true" focusable="false">
        <path
          d={DOOR_PATH}
          fill={onBand ? 'var(--surface)' : FACE_VAR[color]}
          stroke="var(--line)"
          strokeWidth="2.5"
          strokeLinejoin="round"
        />
        {onBand ? (
          <path
            d={PANEL_PATH}
            data-door-panel="true"
            fill={FACE_VAR[color]}
            stroke="var(--line)"
            strokeWidth="1.5"
            strokeLinejoin="round"
          />
        ) : null}
        <path d="M2 40h30" stroke="var(--line)" strokeWidth="2.5" strokeLinecap="round" />
        {face ? (
          <g fill="var(--face-ink)" data-door-face="true">
            <rect x="11" y="18" width="3.2" height="6" rx="1.6" />
            <rect x="19.5" y="18" width="3.2" height="6" rx="1.6" />
          </g>
        ) : (
          <circle cx="23" cy="24" r="2" fill="var(--face-ink)" />
        )}
      </svg>
    </span>
  )
}
