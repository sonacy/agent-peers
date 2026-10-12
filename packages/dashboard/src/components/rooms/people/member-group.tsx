/**
 * MemberGroup (DASHBOARD §4.3): one card per person. Header: avatar, name, 房主 / 我 chips, agent
 * counts and stack, owner actions. Body: AgentChips. Big rooms collapse to the header and cap the
 * chips at 6 behind 再看 N 个.
 */
import { ChevronDown, Ellipsis, UserX } from 'lucide-react'
import type { RoomAgent, RoomPerson } from '../../../api/types'
import { agentStatus } from '../../../lib/agent'
import { cn } from '../../../lib/cn'
import { AvatarStack } from '../../avatar-stack'
import { MemberAvatar } from '../../member-avatar'
import { TruncatedText } from '../../truncated-text'
import { Button } from '../../ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '../../ui/dropdown-menu'
import { CHIP_LIMIT, idleCount } from '../model/people-model'
import { MeChip, RoleChip } from '../role-chip'
import { AgentChip } from './agent-chip'

export interface GroupActions {
  readonly canRemove: (person: RoomPerson) => boolean
  readonly canManage: (person: RoomPerson) => boolean
  readonly onRemoveAgent: (agent: RoomAgent) => void
  readonly onKick: (person: RoomPerson) => void
  /** Phones: open the person sheet instead of inline buttons. */
  readonly onManage?: (person: RoomPerson) => void
}

export interface MemberGroupProps {
  readonly person: RoomPerson
  readonly actions: GroupActions
  /** Big rooms: collapsible with capped chips. */
  readonly big: boolean
  readonly expanded: boolean
  readonly showAll: boolean
  readonly onToggle: () => void
  readonly onShowAll: () => void
}

export function groupMeta(person: RoomPerson): string {
  if (person.agents.length === 0) return '还没有 agent 进来'
  return `${person.agents.length} 个 agent · ${idleCount(person.agents)} 个有空`
}

/** Big rooms: a quiet ⋯ menu next to the chevron instead of a column of danger buttons. */
function KickMenu({ person, actions }: Pick<MemberGroupProps, 'person' | 'actions'>) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button size="icon-sm" variant="ghost" aria-label={`管理 ${person.member}`}>
          <Ellipsis aria-hidden="true" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent>
        <DropdownMenuItem tone="danger" onSelect={() => actions.onKick(person)}>
          <UserX aria-hidden="true" />请 {person.member} 出房间
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function Manage({ person, actions, big }: Pick<MemberGroupProps, 'person' | 'actions' | 'big'>) {
  if (!actions.canManage(person)) return null
  if (actions.onManage !== undefined) {
    const open = actions.onManage
    return (
      <Button
        size="icon-sm"
        variant="ghost"
        aria-label={`管理 ${person.member}`}
        onClick={() => open(person)}
      >
        <Ellipsis aria-hidden="true" />
      </Button>
    )
  }
  if (big) return <KickMenu person={person} actions={actions} />
  return (
    <Button
      size="sm"
      variant="danger-outline"
      onClick={() => actions.onKick(person)}
      aria-label={`请 ${person.member} 出房间`}
    >
      请出房间
    </Button>
  )
}

function Header(props: MemberGroupProps) {
  const { person, big, expanded, onToggle } = props
  const stack = person.agents.map((a) => ({ id: a.card.session_id, expression: agentStatus(a.card) }))
  return (
    <div className="flex items-center gap-3">
      <MemberAvatar memberId={person.member_id} name={person.member} size={32} decorative />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <div className="flex min-w-0 items-center gap-1.5">
          <TruncatedText text={person.member} middle={28} as="h3" className="font-semibold text-card" />
          {person.is_me ? <MeChip /> : null}
          {person.role === 'owner' ? <RoleChip value="owner" /> : null}
        </div>
        <span className="text-meta text-muted">{groupMeta(person)}</span>
      </div>
      {person.agents.length > 0 && (big || !expanded) ? (
        <AvatarStack
          items={stack}
          label={`${person.agents.length} 个 agent`}
          className="hidden sm:inline-flex"
        />
      ) : null}
      {big && person.agents.length > 0 ? (
        <Button
          size="icon-sm"
          variant="ghost"
          aria-expanded={expanded}
          aria-label={`${expanded ? '收起' : '展开'} ${person.member} 的 agent`}
          onClick={onToggle}
        >
          <ChevronDown aria-hidden="true" className={cn('transition-transform', expanded && 'rotate-180')} />
        </Button>
      ) : null}
      <Manage person={person} actions={props.actions} big={big} />
    </div>
  )
}

export function MemberGroup(props: MemberGroupProps) {
  const { person, actions, big, expanded, showAll, onShowAll } = props
  const capped = big && !showAll
  const shown = capped ? person.agents.slice(0, CHIP_LIMIT) : person.agents
  const hidden = person.agents.length - shown.length
  const remove = actions.canRemove(person) ? actions.onRemoveAgent : undefined
  return (
    <article
      aria-label={person.member}
      className={cn(
        'flex flex-col gap-3 rounded-2xl border-2 border-line bg-surface p-3 shadow-hard sm:p-4',
        person.is_me && 'border-primary',
      )}
    >
      <Header {...props} />
      {expanded && person.agents.length > 0 ? (
        <ul
          aria-label={`${person.member} 的 agent`}
          className="grid grid-cols-1 gap-2 sm:grid-cols-[repeat(auto-fill,minmax(240px,1fr))]"
        >
          {shown.map((agent) => (
            <AgentChip key={agent.card.session_id} agent={agent} onRemove={remove} />
          ))}
        </ul>
      ) : null}
      {expanded && hidden > 0 ? (
        <Button size="sm" className="self-start" onClick={onShowAll}>
          再看 {hidden} 个
        </Button>
      ) : null}
    </article>
  )
}
