/** Role chips: 房主 in lime, 成员 / 只读 outlined (DASHBOARD §4.2), and the dark 我 chip. */
import type { Role } from '@agent-peers/protocol'
import { Chip } from '../ui/chip'
import { ROLE_LABEL } from './model/people-model'

export function RoleChip({
  value,
  prefix = '',
  id,
}: {
  readonly value: Role
  readonly prefix?: string
  readonly id?: string
}) {
  return (
    <Chip id={id} tone={value === 'owner' ? 'lime' : 'outline'} className="shrink-0">
      {prefix}
      {ROLE_LABEL[value]}
    </Chip>
  )
}

export function MeChip() {
  return (
    <Chip tone="ink" className="shrink-0">
      我
    </Chip>
  )
}
