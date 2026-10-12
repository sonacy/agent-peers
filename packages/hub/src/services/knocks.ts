/** Knocks (§10.2): request to join a discoverable room; the owner accepts or declines. */
import {
  KNOCK_EXPIRY_MS,
  KNOCK_RETRY_AFTER_DECLINE_MS,
  type Knock,
  type KnockDecision,
  type KnockState,
  PeersError,
} from '@agent-peers/protocol'
import type { KnockRow } from '../storage/repos/knocks'
import type { Access, Actor } from './access'
import type { Effects, ServiceDeps } from './context'
import { toWireKnock } from './wire'

export function createKnocks(deps: ServiceDeps, access: Access) {
  const { repos } = deps

  const wire = (row: KnockRow): Knock => {
    const name = repos.members.byId(row.member_id)?.name ?? 'unknown'
    return toWireKnock(row, name, repos.grants.get(row.room_id, row.member_id)?.kicked === 1)
  }

  /** `knock.updated` to the knocker's open sessions, and the dashboard event to knocker and owner. */
  const publish = (fx: Effects, row: KnockRow): Knock => {
    const knock = wire(row)
    if (row.state !== 'pending') {
      for (const session of repos.sessions.forMember(row.member_id)) {
        if (session.closed_at === null) {
          fx.notify(session.id, 'knock.updated', { knock_id: row.id, room_id: row.room_id, state: row.state })
        }
      }
    }
    const owner = repos.rooms.byId(row.room_id)?.owner_member_id
    fx.emit({
      name: 'knock',
      data: { knock },
      memberIds: owner ? [row.member_id, owner] : [row.member_id],
      roomId: row.room_id,
    })
    return knock
  }

  const knock = (actor: Actor, roomId: string, note?: string): Knock =>
    deps.tx((fx) => {
      if (actor.kind === 'admin') throw new PeersError('forbidden', 'the operator cannot knock')
      const room = access.requireRoom(roomId)
      if (access.activeGrant(roomId, actor.memberId))
        throw new PeersError('already_member', 'you are already a member')
      if (room.discoverable !== 1) throw new PeersError('room_not_found', 'room not found')
      if (repos.knocks.pending(roomId, actor.memberId))
        throw new PeersError('knock_pending', 'you already knocked')
      const declined = repos.knocks.lastDeclined(roomId, actor.memberId)
      const retryAt = (declined?.decided_at ?? 0) + KNOCK_RETRY_AFTER_DECLINE_MS
      if (declined && retryAt > deps.now()) {
        throw new PeersError('rate_limited', 'you can knock again 24 h after a decline', {
          retry_after_ms: retryAt - deps.now(),
        })
      }
      const id = deps.newId()
      const note1 = note === undefined || note === '' ? null : note
      repos.knocks.insert({
        id,
        room_id: roomId,
        member_id: actor.memberId,
        note: note1,
        created_at: deps.now(),
        expires_at: deps.now() + KNOCK_EXPIRY_MS,
      })
      return publish(fx, repos.knocks.byId(id) as KnockRow)
    })

  const requireKnock = (knockId: string): KnockRow => {
    const row = repos.knocks.byId(knockId)
    if (!row) throw new PeersError('invalid_params', 'unknown knock')
    return row
  }

  const transition = (fx: Effects, row: KnockRow, state: KnockState): KnockRow => {
    if (!repos.knocks.decide(row.id, state, deps.now())) {
      throw new PeersError(
        'invalid_params',
        `the knock is already ${repos.knocks.byId(row.id)?.state ?? 'closed'}`,
      )
    }
    const next = repos.knocks.byId(row.id) as KnockRow
    publish(fx, next)
    return next
  }

  const withdraw = (actor: Actor, knockId: string): void =>
    deps.tx((fx) => {
      const row = requireKnock(knockId)
      if (actor.kind === 'admin' || actor.memberId !== row.member_id) {
        throw new PeersError('forbidden', 'only the knocker may withdraw')
      }
      transition(fx, row, 'withdrawn')
    })

  /** Owner only. `accept` creates a `member` grant (restoring a kicked member). */
  const decide = (actor: Actor, knockId: string, decision: KnockDecision): Knock =>
    deps.tx((fx) => {
      const row = requireKnock(knockId)
      access.requireOwner(actor, row.room_id)
      const next = transition(fx, row, decision === 'accept' ? 'accepted' : 'declined')
      if (decision === 'accept') {
        repos.grants.upsert(row.room_id, row.member_id, 'member', deps.now())
        fx.emit({
          name: 'room',
          data: { room_id: row.room_id, change: 'members' },
          memberIds: access.roomMemberIds(row.room_id),
          roomId: row.room_id,
        })
      }
      access.audit(actor, `knock.${decision}`, row.room_id, { knock_id: knockId })
      return wire(next)
    })

  const pendingForRoom = (actor: Actor, roomId: string): readonly Knock[] => {
    access.requireOwner(actor, roomId)
    return repos.knocks.pendingForRoom(roomId).map(wire)
  }

  const pendingForMember = (memberId: string): readonly Knock[] =>
    repos.knocks.pendingForMember(memberId).map(wire)

  /** Sweeper: pending knocks older than 7 days expire. */
  const expireDue = (): number =>
    deps.tx(
      (fx) =>
        repos.knocks.duePending(deps.now()).filter((row) => {
          if (!repos.knocks.decide(row.id, 'expired', deps.now())) return false
          publish(fx, repos.knocks.byId(row.id) as KnockRow)
          return true
        }).length,
    )

  return { knock, withdraw, decide, pendingForRoom, pendingForMember, expireDue, wire }
}
export type Knocks = ReturnType<typeof createKnocks>
