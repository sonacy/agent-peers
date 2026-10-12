/**
 * Settings (DASHBOARD §10). The public URL and the registration mode change at runtime and last
 * until the hub restarts; retention, message and request limits come from startup flags and are
 * shown read-only.
 */
import { type FormEvent, useId, useState } from 'react'
import { ErrorBanner } from '../../components/error-banner'
import { Button } from '../../components/ui/button'
import { Card } from '../../components/ui/card'
import { Input } from '../../components/ui/input'
import { Segmented } from '../../components/ui/segmented'
import { CardSkeleton, DelayedSkeleton } from '../../components/ui/skeleton'
import { useToast } from '../../components/ui/toast'
import { useHubSettings, usePatchSettings } from './admin-queries'
import { type HubSettings, REGISTRATION_MODES, type Registration } from './admin-schemas'
import { adminErrorText, formatDuration, isLoopbackUrl, publicUrlProblem, REGISTRATION_LABEL } from './format'
import { LoopbackWarning } from './hub-status'
import { settingsPatch } from './logic'

const REGISTRATION_OPTIONS = REGISTRATION_MODES.map((value) => ({ value, label: REGISTRATION_LABEL[value] }))

function ReadOnlyRow({ label, value }: { readonly label: string; readonly value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3 border-muted/30 border-b border-dotted py-1.5 last:border-b-0">
      <dt className="text-muted text-sm">{label}</dt>
      <dd className="text-right font-semibold text-sm tabular-nums">{value}</dd>
    </div>
  )
}

function StartupValues({ settings }: { readonly settings: HubSettings }) {
  const limits = settings.rate_limits
  return (
    <section aria-labelledby="startup-values" className="flex flex-col gap-1">
      <h3 id="startup-values" className="font-semibold text-sm">
        启动参数决定的
      </h3>
      <p className="text-meta text-muted">这些在启动 hub 的参数里改，重启后生效。</p>
      <dl className="mt-1 flex flex-col">
        <ReadOnlyRow label="消息保留" value={formatDuration(settings.retention_ms)} />
        <ReadOnlyRow label="每人每分钟消息" value={`${settings.messages_per_minute} 条`} />
        <ReadOnlyRow label="兑换邀请（每 IP 每分钟）" value={`${limits.redeem} 次`} />
        <ReadOnlyRow label="邀请预览（每 IP 每分钟）" value={`${limits.preview} 次`} />
        <ReadOnlyRow label="注册（每 IP 每分钟）" value={`${limits.register} 次`} />
        <ReadOnlyRow label="登录（每 IP 每分钟）" value={`${limits.login} 次`} />
        <ReadOnlyRow label="成员可以建房间" value={settings.allow_room_creation ? '可以' : '不可以'} />
        <ReadOnlyRow
          label="心跳 / 断线宽限"
          value={`${formatDuration(settings.heartbeat_ms)} / ${formatDuration(settings.grace_ms)}`}
        />
      </dl>
    </section>
  )
}

export function SettingsForm({ settings }: { readonly settings: HubSettings }) {
  const patch = usePatchSettings()
  const { toast } = useToast()
  const [url, setUrl] = useState(settings.public_url ?? '')
  const [registration, setRegistration] = useState<Registration>(settings.registration)
  const urlId = useId()
  const urlHintId = useId()
  const changes = settingsPatch(settings, url, registration)
  const dirty = Object.keys(changes).length > 0
  const problem = changes.public_url === undefined ? undefined : publicUrlProblem(url)
  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (!dirty || problem !== undefined) return
    patch.mutate(changes, {
      onSuccess: (saved) => {
        setUrl(saved.public_url ?? '')
        setRegistration(saved.registration)
        toast({ title: '已保存，立即生效', description: '重启 hub 后会回到启动参数。', tone: 'success' })
      },
    })
  }
  return (
    <form onSubmit={submit} className="flex flex-col gap-4">
      <div className="flex flex-col gap-1.5">
        <label htmlFor={urlId} className="font-semibold text-sm">
          公开地址
        </label>
        <Input
          id={urlId}
          type="url"
          inputMode="url"
          spellCheck={false}
          value={url}
          placeholder="https://peers.example.com"
          aria-describedby={urlHintId}
          aria-invalid={problem !== undefined}
          onChange={(event) => setUrl(event.target.value)}
          className="font-mono"
        />
        <p
          id={urlHintId}
          className={problem === undefined ? 'text-meta text-muted' : 'text-meta text-danger'}
        >
          {problem ?? '邀请和登录链接都用这个地址，要让同事的电脑能打开。'}
        </p>
      </div>
      {isLoopbackUrl(url) ? <LoopbackWarning /> : null}
      <div className="flex flex-col gap-1.5">
        <span className="font-semibold text-sm">谁能加入</span>
        <Segmented
          label="注册方式"
          value={registration}
          options={REGISTRATION_OPTIONS}
          onValueChange={setRegistration}
        />
        <p className="text-meta text-muted">
          {registration === 'open'
            ? '开放注册：任何能连上 Core 的人都能自己注册，也能建房间。'
            : '只能用邀请：新的人要拿到房主的邀请才能进来。'}
        </p>
      </div>
      {patch.isError ? <ErrorBanner title="没保存上" description={adminErrorText(patch.error)} /> : null}
      <Button type="submit" variant="primary" disabled={!dirty || problem !== undefined || patch.isPending}>
        {patch.isPending ? '正在保存…' : '保存'}
      </Button>
      <StartupValues settings={settings} />
    </form>
  )
}

export function SettingsSection() {
  const settings = useHubSettings()
  return (
    <Card className="flex flex-col gap-4 p-5" aria-labelledby="settings-title" role="region">
      <h2 id="settings-title" className="font-display font-bold text-section">
        设置
      </h2>
      {settings.isError ? (
        <ErrorBanner
          title="读不到设置"
          description={adminErrorText(settings.error)}
          actionLabel="再试一次"
          onAction={() => void settings.refetch()}
        />
      ) : settings.data === undefined ? (
        <DelayedSkeleton loading fallback={<CardSkeleton />} />
      ) : (
        <SettingsForm settings={settings.data} />
      )}
    </Card>
  )
}
