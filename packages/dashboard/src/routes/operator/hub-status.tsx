/**
 * Hub status (DASHBOARD §10): the dark ink hero card with the public URL, live counts, version and
 * uptime. Counts refresh every 15 s; the loopback warning matches the invite panel's (§4.3).
 */
import { TriangleAlert } from 'lucide-react'
import { ErrorBanner } from '../../components/error-banner'
import { Card } from '../../components/ui/card'
import { Chip } from '../../components/ui/chip'
import { CardSkeleton, DelayedSkeleton } from '../../components/ui/skeleton'
import { formatCount } from '../../lib/format/count'
import { useHubStatus } from './admin-queries'
import type { HubStatus } from './admin-schemas'
import { adminErrorText, formatDuration, isLoopbackUrl, REGISTRATION_LABEL } from './format'

interface Stat {
  readonly label: string
  readonly value: number
  readonly tone: string
}

function stats(status: HubStatus): readonly Stat[] {
  return [
    { label: '在线 agent', value: status.sessions_online, tone: 'bg-lime text-lime-ink' },
    { label: '连接', value: status.connections, tone: 'bg-face-sky text-face-ink' },
    { label: '房间', value: status.rooms, tone: 'bg-face-blush text-face-ink' },
    { label: '成员', value: status.members, tone: 'bg-face-butter text-face-ink' },
  ]
}

function StatTile({ stat }: { readonly stat: Stat }) {
  return (
    <div className="flex flex-col gap-1 rounded-xl border-2 border-line bg-surface p-3 text-ink">
      <span
        className={`inline-flex w-fit rounded-lg border-2 border-line px-2 py-0.5 font-display font-extrabold text-2xl tabular-nums ${stat.tone}`}
      >
        {formatCount(stat.value, 9999)}
      </span>
      <span className="text-meta text-muted">{stat.label}</span>
    </div>
  )
}

export function LoopbackWarning() {
  return (
    <p className="flex items-start gap-2 rounded-xl border-2 border-line bg-warn px-3 py-2 text-sm text-warn-ink">
      <TriangleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
      公开地址是 localhost，同事的电脑连不上，邀请和登录链接也打不开。部署到大家都能访问的地址再发邀请。
    </p>
  )
}

export function StatusCard({ status }: { readonly status: HubStatus }) {
  return (
    <Card tone="ink" className="relative flex flex-col gap-4 overflow-hidden p-5 sm:p-6">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="mr-auto font-display font-bold text-section">Core 状态</h2>
        <Chip tone="lime">v{status.version}</Chip>
        <Chip tone="outline">已运行 {formatDuration(status.uptime_ms)}</Chip>
        <Chip tone="outline">{REGISTRATION_LABEL[status.registration]}</Chip>
      </div>
      <dl className="flex min-w-0 flex-col gap-1">
        <dt className="text-meta opacity-75">公开地址</dt>
        <dd className="break-all font-mono text-sm">{status.public_url ?? '没设置（用本机监听地址）'}</dd>
      </dl>
      {isLoopbackUrl(status.public_url) ? <LoopbackWarning /> : null}
      <ul className="grid grid-cols-2 gap-3 lg:grid-cols-4" aria-label="实时数字">
        {stats(status).map((stat) => (
          <li key={stat.label}>
            <StatTile stat={stat} />
          </li>
        ))}
      </ul>
    </Card>
  )
}

export function HubStatusSection() {
  const status = useHubStatus()
  if (status.isError) {
    return (
      <ErrorBanner
        title="读不到 Core 状态"
        description={adminErrorText(status.error)}
        actionLabel="再试一次"
        onAction={() => void status.refetch()}
      />
    )
  }
  if (status.data === undefined) return <DelayedSkeleton loading fallback={<CardSkeleton />} />
  return <StatusCard status={status.data} />
}
