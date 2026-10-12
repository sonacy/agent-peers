/**
 * Presence (§5): hub-owned connection state (online → stale → offline after `grace_ms`) and the
 * coalesced `presence.changed` fan-out (at most once per second per session). Only online ↔ offline
 * transitions are announced, so a reattach within `grace_ms` is invisible to other members.
 */
import { PRESENCE_FANOUT_MS } from '@agent-peers/protocol'
import { guarded, type TimerHandle } from '../clock'
import type { Access } from './access'
import type { Asks } from './asks'
import type { Cards } from './cards'
import type { Effects, ServiceDeps } from './context'

interface FanoutState {
  readonly last: number
  readonly timer?: TimerHandle
}

export function createPresence(deps: ServiceDeps, access: Access, cards: Cards, asks: Asks) {
  const { repos, clock } = deps
  const logger = deps.config.logger
  const offlineTimers = new Map<string, TimerHandle>()
  const fanouts = new Map<string, FanoutState>()

  const cancelOffline = (sessionId: string) => {
    const timer = offlineTimers.get(sessionId)
    if (timer !== undefined) clock.clearTimeout(timer)
    offlineTimers.delete(sessionId)
  }

  /** `presence.changed` to every room the session is in, plus dashboard events (inside a tx). */
  const announce = (fx: Effects, sessionId: string, extraRooms: readonly string[] = []): void => {
    const pending = fanouts.get(sessionId)?.timer
    if (pending !== undefined) clock.clearTimeout(pending)
    fanouts.set(sessionId, { last: deps.now() })
    const row = repos.sessions.byId(sessionId)
    if (!row) return
    const card = cards.build(row)
    fx.emit({ name: 'session', data: { session: card }, memberIds: [row.member_id] })
    for (const room of card.rooms) {
      const params = { room_id: room.room_id, handle: room.handle, card }
      access.notifyRoom(fx, room.room_id, 'presence.changed', params, sessionId)
      fx.emit({
        name: 'presence',
        data: params,
        memberIds: access.roomMemberIds(room.room_id),
        roomId: room.room_id,
      })
    }
    for (const roomId of extraRooms) {
      fx.emit({
        name: 'room',
        data: { room_id: roomId, change: 'members' },
        memberIds: access.roomMemberIds(roomId),
        roomId,
      })
    }
  }

  /** Coalesced fan-out for activity and card updates (§5.2). */
  const changed = (sessionId: string): void => {
    const state = fanouts.get(sessionId)
    if (state?.timer !== undefined) return
    const wait = state ? state.last + PRESENCE_FANOUT_MS - deps.now() : 0
    if (wait <= 0) {
      deps.tx((fx) => announce(fx, sessionId))
      return
    }
    const timer = clock.setTimeout(
      guarded(logger, 'presence fan-out', () => {
        fanouts.set(sessionId, { last: deps.now() })
        deps.tx((fx) => announce(fx, sessionId))
      }),
      wait,
    )
    fanouts.set(sessionId, { last: state?.last ?? 0, timer })
  }

  /** The session is attached to a live connection; announced only when it was offline. */
  const online = (fx: Effects, sessionId: string, announceChange = true): boolean => {
    cancelOffline(sessionId)
    const before = repos.sessions.byId(sessionId)?.connection
    repos.sessions.setConnection(sessionId, 'online', deps.now())
    const wasOffline = before === 'offline'
    if (wasOffline && announceChange) announce(fx, sessionId)
    return wasOffline
  }

  /** A frame arrived on a connection whose sessions were stale; returns those that had gone offline. */
  const revive = (sessionIds: readonly string[]): readonly string[] =>
    deps.tx((fx) => sessionIds.filter((id) => online(fx, id)))

  const goOffline = (fx: Effects, sessionId: string, close: boolean): void => {
    cancelOffline(sessionId)
    const row = repos.sessions.byId(sessionId)
    if (!row) return
    if (close) repos.sessions.close(sessionId, deps.now())
    else repos.sessions.setConnection(sessionId, 'offline', deps.now())
    asks.holderLost(fx, sessionId)
    if (row.connection !== 'offline' || close) announce(fx, sessionId)
  }

  const offline = (sessionId: string, close = false): void => deps.tx((fx) => goOffline(fx, sessionId, close))

  /**
   * Unclean close or missed heartbeats: stale now, offline after `grace_ms` (§5.1). The grace period
   * runs from the first transition: a session already stale with a pending timer keeps that timer.
   */
  const stale = (sessionIds: readonly string[]): void => {
    for (const id of sessionIds) {
      const row = repos.sessions.byId(id)
      if (!row || row.connection === 'offline') continue
      if (row.connection === 'stale' && offlineTimers.has(id)) continue
      repos.sessions.setConnection(id, 'stale', row.last_seen_at)
      cancelOffline(id)
      offlineTimers.set(
        id,
        clock.setTimeout(
          guarded(logger, 'presence offline', () => {
            offlineTimers.delete(id)
            offline(id)
          }),
          deps.config.graceMs,
        ),
      )
    }
  }

  /**
   * Hub start: sessions the database still shows online or stale lost their connections when the
   * hub went down. They get the normal grace period, so asks are requeued or failed (§6.2) unless
   * the bridge reattaches in time.
   */
  const recover = (): readonly string[] => {
    const ids = repos.sessions
      .notOffline()
      .filter((s) => s.closed_at === null)
      .map((s) => s.id)
    stale(ids)
    return ids
  }

  /** Drops fan-out bookkeeping that no longer throttles anything (called by the sweeper). */
  const prune = (): number => {
    const cutoff = deps.now() - PRESENCE_FANOUT_MS
    const idle = [...fanouts].filter(([, state]) => state.timer === undefined && state.last <= cutoff)
    for (const [id] of idle) fanouts.delete(id)
    return idle.length
  }

  const stop = (): void => {
    for (const timer of offlineTimers.values()) clock.clearTimeout(timer)
    for (const state of fanouts.values()) if (state.timer !== undefined) clock.clearTimeout(state.timer)
    offlineTimers.clear()
    fanouts.clear()
  }

  return {
    announce,
    changed,
    online,
    revive,
    goOffline,
    offline,
    stale,
    recover,
    prune,
    stop,
    pendingOffline: () => offlineTimers.size,
    trackedFanouts: () => fanouts.size,
  }
}
export type Presence = ReturnType<typeof createPresence>
