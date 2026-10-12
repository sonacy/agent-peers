/**
 * Many rooms as a table (DASHBOARD §4.2); on phones each row becomes a two-line list item so the
 * page never scrolls sideways (§9).
 */
import { Link } from 'wouter'
import { PATHS } from '../../../routes/paths'
import { RelativeTime } from '../../relative-time'
import { RoomDoor } from '../../room-door'
import { Badge } from '../../ui/badge'
import { Button } from '../../ui/button'
import { Chip } from '../../ui/chip'
import { type RoomRow, rowName } from '../model/rooms-model'
import { RoleChip } from '../role-chip'

export interface RoomsTableProps {
  readonly rows: readonly RoomRow[]
  readonly onWithdraw: (row: Extract<RoomRow, { kind: 'knock' }>) => void
}

function NameCell({ row }: { readonly row: RoomRow }) {
  const name = rowName(row)
  const inner = (
    <>
      <RoomDoor roomId={row.id} size={28} />
      <span className="truncate font-semibold" title={name}>
        {name}
      </span>
    </>
  )
  if (row.kind === 'knock') return <span className="flex min-w-0 items-center gap-2.5">{inner}</span>
  return (
    <Link
      href={PATHS.room(row.id)}
      className="focus-ring flex min-h-11 min-w-0 items-center gap-2.5 rounded-lg"
    >
      {inner}
    </Link>
  )
}

function RoleCell({ row }: { readonly row: RoomRow }) {
  return row.kind === 'room' ? (
    <RoleChip value={row.room.role} />
  ) : (
    <Chip tone="warn" className="shrink-0">
      等开门
    </Chip>
  )
}

function KnockCell({
  row,
  onWithdraw,
}: {
  readonly row: RoomRow
  readonly onWithdraw: RoomsTableProps['onWithdraw']
}) {
  if (row.kind === 'knock') {
    return (
      <Button size="sm" onClick={() => onWithdraw(row)} aria-label={`撤回敲 ${rowName(row)} 的门`}>
        撤回
      </Button>
    )
  }
  const count = row.room.pending_knocks ?? 0
  return count > 0 ? (
    <Badge count={count} tone="blush" label={`${count} 人在敲门`} />
  ) : (
    <span aria-hidden="true">—</span>
  )
}

function activity(row: RoomRow) {
  const ts = row.kind === 'room' ? row.room.last_activity_at : null
  return ts === null ? <span className="text-muted">—</span> : <RelativeTime ts={ts} />
}

function owner(row: RoomRow): string {
  return (row.kind === 'room' ? row.room.room.owner : row.info?.owner) ?? '—'
}

function agents(row: RoomRow): string {
  if (row.kind === 'knock') return '—'
  return row.room.agents === 0 ? `${row.mine} / 0 · 还没人来` : `${row.mine} / ${row.room.agents}`
}

function people(row: RoomRow): string {
  if (row.kind === 'room') return String(row.room.people)
  return row.info === undefined ? '—' : String(row.info.member_count)
}

const TH = 'px-3 py-2.5 text-left font-medium text-meta text-muted'
const TD = 'px-3 py-1 text-sm'

export function RoomsTable({ rows, onWithdraw }: RoomsTableProps) {
  return (
    <div className="overflow-hidden rounded-2xl border-2 border-line bg-surface shadow-hard">
      <table className="w-full table-fixed border-collapse">
        <caption className="sr-only">我的房间</caption>
        <thead className="border-line border-b-2">
          <tr>
            <th scope="col" className={`${TH} w-[34%]`}>
              房间
            </th>
            <th scope="col" className={TH}>
              房主
            </th>
            <th scope="col" className={`${TH} w-16`}>
              人数
            </th>
            <th scope="col" className={TH}>
              agent（我的 / 全部）
            </th>
            <th scope="col" className={`${TH} w-20`}>
              我是
            </th>
            <th scope="col" className={TH}>
              最近活跃
            </th>
            <th scope="col" className={`${TH} w-20`}>
              敲门
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={`${row.kind}:${row.id}`} className="border-surface-2 border-b last:border-b-0">
              <td className={TD}>
                <NameCell row={row} />
              </td>
              <td className={`${TD} truncate`} title={owner(row)}>
                {owner(row)}
              </td>
              <td className={`${TD} tabular-nums`}>{people(row)}</td>
              <td className={`${TD} truncate tabular-nums`}>{agents(row)}</td>
              <td className={TD}>
                <RoleCell row={row} />
              </td>
              <td className={`${TD} text-muted`}>{activity(row)}</td>
              <td className={TD}>
                <KnockCell row={row} onWithdraw={onWithdraw} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

/** Phone form: name + role on the first line, owner · people · activity on the second. */
export function RoomsList({ rows, onWithdraw }: RoomsTableProps) {
  return (
    <ul
      aria-label="我的房间"
      className="flex flex-col divide-y divide-surface-2 rounded-2xl border-2 border-line bg-surface shadow-hard"
    >
      {rows.map((row) => (
        <li key={`${row.kind}:${row.id}`} className="flex flex-col gap-1 px-3 py-2">
          <div className="flex items-center gap-2">
            <div className="min-w-0 flex-1">
              <NameCell row={row} />
            </div>
            <RoleCell row={row} />
            <KnockCell row={row} onWithdraw={onWithdraw} />
          </div>
          <p className="flex flex-wrap gap-x-2 pl-9 text-meta text-muted">
            <span>房主 {owner(row)}</span>
            <span>{people(row)} 人</span>
            <span>{activity(row)}</span>
          </p>
        </li>
      ))}
    </ul>
  )
}
