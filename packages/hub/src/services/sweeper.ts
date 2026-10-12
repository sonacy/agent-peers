/**
 * Periodic housekeeping: ask TTLs (§6.2), knock expiry (§10.2), the dedup window (§6.4), login codes,
 * web sessions, message retention (§9) and the idle-close backstop for sessions that never closed (§5.1).
 */
import { DEDUP_WINDOW_MS, MESSAGE_RETENTION_MS } from '@agent-peers/protocol'
import type { TimerHandle } from '../clock'
import type { Asks } from './asks'
import type { ServiceDeps } from './context'
import type { Knocks } from './knocks'
import type { Presence } from './presence'

export interface SweepReport {
  readonly expiredAsks: number
  readonly expiredKnocks: number
  readonly idleClosed: number
  readonly deletedMessages: number
}

export function createSweeper(deps: ServiceDeps, asks: Asks, knocks: Knocks, presence: Presence) {
  const { repos, clock } = deps
  let timer: TimerHandle | undefined
  let running = false

  const idleClose = (): number => {
    if (deps.config.idleCloseMs === 0) return 0
    const idle = repos.sessions
      .idleOpen(deps.now() - deps.config.idleCloseMs)
      .filter((s) => s.connection !== 'online')
    for (const session of idle) presence.offline(session.id, true)
    return idle.length
  }

  const sweep = (): SweepReport => {
    const now = deps.now()
    const report = {
      expiredAsks: asks.expireDue(),
      expiredKnocks: knocks.expireDue(),
      idleClosed: idleClose(),
      deletedMessages: deps.tx(() => repos.messages.deleteOlderThan(now - MESSAGE_RETENTION_MS)),
    }
    presence.prune()
    deps.tx(() => {
      repos.idempotency.deleteOlderThan(now - DEDUP_WINDOW_MS)
      repos.loginCodes.deleteExpired(now)
      repos.webSessions.deleteExpired(now)
    })
    return report
  }

  const schedule = () => {
    timer = clock.setTimeout(() => {
      try {
        sweep()
      } catch (error) {
        deps.config.logger.error('sweep failed', error)
      }
      if (running) schedule()
    }, deps.config.sweepIntervalMs)
  }

  return {
    sweep,
    start() {
      if (running) return
      running = true
      schedule()
    },
    stop() {
      running = false
      if (timer !== undefined) clock.clearTimeout(timer)
      timer = undefined
    },
  }
}
export type Sweeper = ReturnType<typeof createSweeper>
