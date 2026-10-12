/** Members and their tokens (§2, §8): register, redeem-as-new-member, authenticate, revoke. */
import { isValidName, MEMBER_COOKIE_TTL_MS, nextFreeName, PeersError, type Role } from '@agent-peers/protocol'
import { generateToken, sha256Hex } from '../auth/tokens'
import type { MemberRow } from '../storage/repos/members'
import type { Access } from './access'
import type { ServiceDeps } from './context'
import type { Invites } from './invites'
import type { Presence } from './presence'

export interface IssuedMember {
  readonly member: MemberRow
  /** Shown once; the hub keeps only its hash. */
  readonly token: string
  /** True when a numeric suffix was added to the requested name. */
  readonly renamed: boolean
}

export interface RedeemResult extends IssuedMember {
  readonly grant: { readonly room_id: string; readonly member: string; readonly role: Role }
}

export function createMembers(deps: ServiceDeps, access: Access, invites: Invites, presence: Presence) {
  const { repos } = deps

  const insertMember = (requested: string, allowSuffix: boolean): { member: MemberRow; renamed: boolean } => {
    if (!isValidName(requested))
      throw new PeersError('invalid_name', 'member names must match ^[a-z0-9][a-z0-9_-]{0,31}$')
    const taken = (name: string) => repos.members.byName(name) !== undefined
    if (!allowSuffix && taken(requested))
      throw new PeersError('invalid_name', `${requested} is taken`, { reason: 'taken' })
    const name = nextFreeName(requested, taken)
    const member = repos.members.insert({ id: deps.newId(), name, created_at: deps.now() })
    return { member, renamed: name !== requested }
  }

  const issueToken = (memberId: string): string => {
    const token = generateToken('member')
    repos.memberTokens.insert(sha256Hex(token), memberId, deps.now())
    return token
  }

  /** Creates a member (suffixing the name on conflict when allowed) and issues a token. */
  const create = (name: string, options: { readonly allowSuffix?: boolean } = {}): IssuedMember =>
    deps.tx(() => {
      const { member, renamed } = insertMember(name, options.allowSuffix ?? true)
      return { member, token: issueToken(member.id), renamed }
    })

  /** `POST /v0/members/register` (§9): only when `registration: open`. */
  const register = (name: string): IssuedMember => {
    if (deps.config.registration !== 'open') throw new PeersError('forbidden', 'registration is invite-only')
    return create(name, { allowSuffix: false })
  }

  /** `POST /v0/invites/redeem` for a caller with no token yet: a new member plus a grant. */
  const redeemAsNew = (code: string, memberName: string): RedeemResult =>
    deps.tx((fx) => {
      invites.resolve(code)
      const { member, renamed } = insertMember(memberName, true)
      const { room, grant } = invites.redeem(fx, code, member.id)
      access.audit({ kind: 'member', memberId: member.id }, 'invite.redeem', room.id)
      return {
        member,
        token: issueToken(member.id),
        renamed,
        grant: { room_id: room.id, member: member.name, role: grant.role },
      }
    })

  /** Redeem with an existing member identity. */
  const redeemFor = (memberId: string, code: string): RedeemResult['grant'] =>
    deps.tx((fx) => {
      const member = repos.members.byId(memberId)
      if (!member) throw new PeersError('unauthorized', 'unknown member')
      const { room, grant } = invites.redeem(fx, code, memberId)
      return { room_id: room.id, member: member.name, role: grant.role }
    })

  /** Resolves a bearer token to its member; undefined when unknown or revoked. */
  const authenticate = (token: string): MemberRow | undefined => {
    const row = repos.memberTokens.active(sha256Hex(token))
    return row ? repos.members.byId(row.member_id) : undefined
  }

  /**
   * Revokes every token of a member. Tokens are only checked at upgrade, so after the commit the
   * member's live sockets are closed (4401) and their sessions go offline at once.
   */
  const revokeTokens = (memberId: string): number =>
    deps.tx((fx) => {
      const count = repos.memberTokens.revokeAll(memberId, deps.now())
      repos.webSessions.deleteForMember(memberId)
      access.audit({ kind: 'admin' }, 'member.revoke_tokens', undefined, { member_id: memberId })
      fx.after(() => {
        for (const sessionId of deps.link.disconnectMember(memberId)) presence.offline(sessionId)
      })
      return count
    })

  return {
    create,
    register,
    redeemAsNew,
    redeemFor,
    authenticate,
    issueToken,
    revokeTokens,
    cookieTtlMs: MEMBER_COOKIE_TTL_MS,
  }
}
export type Members = ReturnType<typeof createMembers>
