/** Core connection UI (DASHBOARD §5, §7): the pill in the top bar and the hub-unreachable banner. */
import { useNow } from '../../lib/hooks/use-now'
import { useLive } from '../../live/live-provider'
import { CorePill, secondsUntil } from '../core-pill'
import { HubErrorBanner } from '../error-banner'

function currentOrigin(): string {
  return typeof location === 'undefined' ? '' : location.origin
}

function currentHost(): string {
  return typeof location === 'undefined' ? 'Core' : location.host
}

export function LiveCorePill({ className }: { readonly className?: string }) {
  const { status } = useLive()
  return (
    <CorePill
      className={className}
      state={status.state}
      details={{ url: currentOrigin(), lastError: status.lastError, nextRetryAt: status.nextRetryAt }}
    />
  )
}

export function ConnectionBanner() {
  const { status, stale, retryNow } = useLive()
  const now = useNow(1000)
  if (!stale) return null
  const seconds = status.nextRetryAt === undefined ? 0 : secondsUntil(status.nextRetryAt, now)
  return <HubErrorBanner host={currentHost()} retryInSeconds={seconds} onRetry={retryNow} />
}
