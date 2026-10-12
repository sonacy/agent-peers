/** A person's avatar (DASHBOARD §3): the face palette hashed by `member_id`, in a circle, with an initial. */
import { cn } from '../lib/cn'
import { initialOf } from '../lib/format/text'
import { FACE_BG, faceColor } from '../lib/hash'

export const MEMBER_SIZES = [44, 32, 28, 22] as const
export type MemberAvatarSize = (typeof MEMBER_SIZES)[number]

const SIZE: Readonly<Record<MemberAvatarSize, string>> = {
  44: 'size-11 border-2 text-base',
  32: 'size-8 border-2 text-sm',
  28: 'size-7 border-[1.5px] text-xs',
  22: 'size-[22px] border-[1.5px] text-[10px]',
}

export interface MemberAvatarProps {
  readonly memberId: string
  readonly name: string
  readonly size?: MemberAvatarSize
  /** Hide from assistive tech when the name is printed next to it. */
  readonly decorative?: boolean
  readonly className?: string
}

export function MemberAvatar({
  memberId,
  name,
  size = 32,
  decorative = false,
  className,
}: MemberAvatarProps) {
  const color = faceColor(memberId)
  const a11y = decorative ? { 'aria-hidden': true as const } : { role: 'img' as const, 'aria-label': name }
  return (
    <span
      data-face-color={color}
      className={cn(
        'inline-flex shrink-0 select-none items-center justify-center rounded-full border-line font-display font-bold text-face-ink',
        SIZE[size],
        FACE_BG[color],
        className,
      )}
      {...a11y}
    >
      {initialOf(name)}
    </span>
  )
}
