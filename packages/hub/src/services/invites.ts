/**
 * Invites (§8, §10.1): one active invite per room, codes stored as SHA-256 + last four. The code is
 * derived from the hub's invite secret, so owners can see the full join prompt again (ONBOARDING §2).
 */
import {
  type Invite,
  type InviteLang,
  isLoopbackHost,
  maskInviteCode,
  PeersError,
  type Role,
  renderJoinPrompt,
} from '@agent-peers/protocol'
import { deriveInviteCode, normalizeInviteCode, sha256Hex } from '../auth/tokens'
import type { GrantRow } from '../storage/repos/grants'
import type { InviteCloseReason, InviteRow } from '../storage/repos/invites'
import type { RoomRow } from '../storage/repos/rooms'
import type { Access, Actor } from './access'
import type { Effects, ServiceDeps } from './context'

export interface RenderOptions {
  readonly lang?: InviteLang
  readonly suggestedHandle?: string
}

export interface RenderedInvite {
  readonly invite_url: string
  readonly join_prompt: string
  readonly join_command: string
  readonly expires_at: null
  readonly loopback: boolean
}

export interface InviteChange {
  readonly invite_url?: string
  readonly join_prompt?: string
}

export function createInvites(deps: ServiceDeps, access: Access) {
  const { repos } = deps

  const codeFor = (invite: InviteRow): string | undefined => {
    const code = deriveInviteCode(deps.runtime.inviteSecret, invite.id)
    return sha256Hex(code) === invite.code_hash ? code : undefined
  }

  const emitInvite = (fx: Effects, room: RoomRow) =>
    fx.emit({
      name: 'room',
      data: { room_id: room.id, change: 'invite' },
      memberIds: room.owner_member_id ? [room.owner_member_id] : [],
      roomId: room.id,
    })

  /** Mints a new active invite, closing the previous one (inside the caller's transaction). */
  const mint = (fx: Effects, room: RoomRow, createdBy: string | null): InviteRow => {
    const previous = repos.invites.active(room.id)
    if (previous) repos.invites.close(previous.id, deps.now(), 'rotated')
    const id = deps.newId()
    const code = deriveInviteCode(deps.runtime.inviteSecret, id)
    const row: InviteRow = {
      id,
      room_id: room.id,
      code_hash: sha256Hex(code),
      last4: code.slice(-4),
      role: 'member',
      created_by: createdBy,
      created_at: deps.now(),
      closed_at: null,
      closed_reason: null,
    }
    repos.invites.insert(row)
    emitInvite(fx, room)
    return row
  }

  const inviterName = (room: RoomRow): string => access.ownerName(room) ?? 'admin'

  const publicUrl = (): string => {
    const url = deps.runtime.publicUrl
    if (url === undefined) {
      throw new PeersError(
        'forbidden',
        'invites need --public-url when the hub listens on a non-loopback address',
      )
    }
    return url
  }

  const render = (room: RoomRow, invite: InviteRow, options: RenderOptions = {}): RenderedInvite => {
    const code = codeFor(invite)
    if (code === undefined)
      throw new PeersError('invite_invalid', 'the invite secret changed; rotate the invite')
    const prompt = renderJoinPrompt({
      publicUrl: publicUrl(),
      code,
      room: room.display_name ?? room.name,
      inviter: inviterName(room),
      cliVersion: deps.config.version,
      lang: options.lang ?? 'en',
      expiresAt: null,
      ...(options.suggestedHandle !== undefined ? { suggestedHandle: options.suggestedHandle } : {}),
    })
    return {
      invite_url: prompt.inviteUrl,
      join_prompt: prompt.prompt,
      join_command: prompt.command,
      expires_at: null,
      loopback: prompt.loopback,
    }
  }

  const isLoopback = (): boolean => {
    try {
      const url = deps.runtime.publicUrl
      return url !== undefined && isLoopbackHost(new URL(url).hostname)
    } catch {
      return false
    }
  }

  /** The owner's view of the room's invite (§10.1), active or the latest closed one. */
  const view = (roomId: string): Invite | null => {
    const invite = repos.invites.active(roomId) ?? repos.invites.latest(roomId)
    if (!invite) return null
    return {
      room_id: roomId,
      state: invite.closed_at === null ? 'active' : 'closed',
      code_masked: maskInviteCode(invite.last4),
      role: invite.role,
      created_at: invite.created_at,
      uses_left: null,
      expires_at: null,
      loopback: isLoopback(),
    }
  }

  const change = (room: RoomRow, invite: InviteRow | undefined): InviteChange => {
    if (!invite || deps.runtime.publicUrl === undefined) return {}
    const rendered = render(room, invite)
    return { invite_url: rendered.invite_url, join_prompt: rendered.join_prompt }
  }

  const rotate = (actor: Actor, roomId: string): InviteChange =>
    deps.tx((fx) => {
      const room = access.requireOwner(actor, roomId)
      const invite = mint(fx, room, actorMember(actor))
      access.audit(actor, 'invite.rotate', roomId)
      return change(room, invite)
    })

  const close = (actor: Actor, roomId: string, reason: InviteCloseReason = 'closed'): InviteChange =>
    deps.tx((fx) => {
      const room = access.requireOwner(actor, roomId)
      const active = repos.invites.active(roomId)
      if (active) repos.invites.close(active.id, deps.now(), reason)
      emitInvite(fx, room)
      access.audit(actor, 'invite.close', roomId)
      return {}
    })

  const reopen = (actor: Actor, roomId: string): InviteChange =>
    deps.tx((fx) => {
      const room = access.requireOwner(actor, roomId)
      const invite = repos.invites.active(roomId) ?? mint(fx, room, actorMember(actor))
      access.audit(actor, 'invite.reopen', roomId)
      return change(room, invite)
    })

  /** `invite.create`: the room's single invite, rendered (a closed invite is reopened). */
  const createFor = (actor: Actor, roomId: string, options: RenderOptions = {}): RenderedInvite =>
    deps.tx((fx) => {
      const room = access.requireOwner(actor, roomId)
      publicUrl()
      const invite = repos.invites.active(roomId) ?? mint(fx, room, actorMember(actor))
      return render(room, invite, options)
    })

  /** Finds the room behind a code; distinguishes closed, rotated and unknown codes. */
  const resolve = (code: string): { readonly invite: InviteRow; readonly room: RoomRow } => {
    const invite = repos.invites.byHash(sha256Hex(normalizeInviteCode(code)))
    if (!invite) throw new PeersError('invite_invalid', 'unknown invite code')
    const room = repos.rooms.byId(invite.room_id)
    if (!room || room.dissolved_at !== null) throw new PeersError('room_not_found', 'the room was dissolved')
    if (invite.closed_at !== null) {
      if (!repos.invites.active(room.id))
        throw new PeersError('invite_closed', 'invites to this room are closed')
      throw new PeersError('invite_invalid', 'this invite was replaced')
    }
    return { invite, room }
  }

  /**
   * Redeems a code for a member (inside a transaction). An active grant is kept as is. A kicked
   * member may only use an invite created after the kick (§8 "until a new invite is redeemed").
   */
  const redeem = (
    fx: Effects,
    code: string,
    memberId: string,
  ): { readonly room: RoomRow; readonly grant: GrantRow; readonly created: boolean } => {
    const { invite, room } = resolve(code)
    const existing = repos.grants.get(room.id, memberId)
    if (existing && existing.revoked_at === null) return { room, grant: existing, created: false }
    if (existing?.kicked === 1 && (existing.kicked_at ?? 0) >= invite.created_at) {
      throw new PeersError('forbidden', 'you were removed from this room; ask the owner for a new invite')
    }
    const role: Role = invite.role === 'owner' ? 'member' : invite.role
    repos.grants.upsert(room.id, memberId, role, deps.now())
    fx.emit({
      name: 'room',
      data: { room_id: room.id, change: 'members' },
      memberIds: access.roomMemberIds(room.id),
      roomId: room.id,
    })
    const grant = repos.grants.get(room.id, memberId) as GrantRow
    return { room, grant, created: true }
  }

  /** Public preview data for `GET /v0/invites/<code>` (§9). */
  const preview = (code: string) => {
    const { room } = resolve(code)
    return {
      room: access.wireRoom(room),
      inviter: inviterName(room),
      description: room.description,
      expires_at: null,
      uses_left: null,
    }
  }

  /** The owner's join prompt for dashboards; null when it can't be rendered. */
  const promptFor = (roomId: string, options: RenderOptions = {}): string | null => {
    const room = access.requireRoom(roomId)
    const invite = repos.invites.active(roomId)
    if (!invite || deps.runtime.publicUrl === undefined || codeFor(invite) === undefined) return null
    return render(room, invite, options).join_prompt
  }

  return {
    mint,
    render,
    view,
    rotate,
    close,
    reopen,
    createFor,
    resolve,
    redeem,
    preview,
    promptFor,
    codeFor,
  }
}
export type Invites = ReturnType<typeof createInvites>

function actorMember(actor: Actor): string | null {
  return actor.kind === 'admin' ? null : actor.memberId
}
