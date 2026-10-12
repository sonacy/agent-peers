/**
 * Steps 4 and 5 of `join` (ONBOARDING §3): membership without consuming an invite use when a grant
 * already exists, then the room join and the one-time hello.
 *
 * | Situation                         | Action                                          |
 * |-----------------------------------|-------------------------------------------------|
 * | token for this hub + active grant | already a member: join by `room_id`             |
 * | token, no grant                   | redeem with that token (`room.join {invite_code}`) |
 * | no token                          | redeem as a new member over HTTP, save the token |
 */
import type { LocalHome, SessionHandle } from '@agent-peers/core'
import {
  type DeepReadonly,
  isPeersError,
  isValidName,
  type MemberEntry,
  PeersError,
  suffixName,
} from '@agent-peers/protocol'
import { type FetchFn, redeemAsNewMember } from './hub-http'

export interface Membership {
  readonly token: string
  readonly member: string
  /** This run redeemed the invite as a new member. */
  readonly fresh: boolean
  readonly line: string
}

export interface HandleChoice {
  readonly name: string
  /** Explicit (`--handle`) or remembered: never suffixed (ONBOARDING §3 step 5). */
  readonly fixed: boolean
}

/** Step 4 for a caller without a token: redeem as a new member and persist the token at once. */
export async function ensureCredential(
  local: LocalHome,
  fetchFn: FetchFn,
  invite: { readonly origin: string; readonly code: string },
  memberName: string,
): Promise<Membership> {
  const existing = await local.credentialFor(invite.origin)
  if (existing) {
    const who = existing.member ? ` as ${existing.member}` : ''
    return { token: existing.member_token, member: existing.member ?? '', fresh: false, line: who }
  }
  const redeemed = await redeemAsNewMember(fetchFn, invite.origin, invite.code, memberName)
  await local.setCredential(invite.origin, {
    member_token: redeemed.member_token,
    member: redeemed.member.name,
  })
  const suffix = redeemed.renamed
    ? ` (${memberName} was taken: you are member ${redeemed.member.name} on this hub)`
    : ''
  return {
    token: redeemed.member_token,
    member: redeemed.member.name,
    fresh: true,
    line: `redeemed the invite as new member ${redeemed.member.name}${suffix}`,
  }
}

export type JoinTargetRef = { readonly room_id: string } | { readonly invite_code: string }

export interface Joined {
  readonly kind: 'joined'
  readonly handle: string
  readonly members: readonly DeepReadonly<MemberEntry>[]
  /** Step 4 created the grant in this run: the hello is due. */
  readonly grantCreated: boolean
  /** This session already held the room (a rerun): nothing was claimed. */
  readonly rejoined: boolean
  readonly notes: readonly string[]
  readonly membershipLine: string
}

/** The handle is held by a live session of this member: `already joined as @h` (exit 0). */
export interface AlreadyJoined {
  readonly kind: 'already'
  readonly handle: string
  readonly membershipLine: string
}

/** A fixed handle is taken by someone else. */
export class HandleTakenError extends PeersError {
  constructor(
    readonly handle: string,
    readonly suggestion: string | undefined,
    /** The hub's `same_member`: the holder is a live session of this member (undefined: not said). */
    readonly sameMember?: boolean,
  ) {
    super('handle_taken', `@${handle} is taken`)
  }
}

function sameMemberOf(error: PeersError): boolean | undefined {
  const value = error.data?.same_member
  return typeof value === 'boolean' ? value : undefined
}

const MAX_SUFFIX_TRIES = 5

function suggestionOf(error: PeersError, handle: string, attempt: number): string {
  const suggested = error.data?.suggestion
  return typeof suggested === 'string' && isValidName(suggested) ? suggested : suffixName(handle, attempt + 2)
}

/** `room.join`; a derived handle moves to the hub's free suggestion, a fixed one never does. */
async function claim(
  session: SessionHandle,
  target: JoinTargetRef,
  choice: HandleChoice,
): Promise<{ readonly handle: string; readonly members: Joined['members']; readonly notes: string[] }> {
  let handle = choice.name
  const notes: string[] = []
  for (let attempt = 0; ; attempt += 1) {
    try {
      const result = await session.join({ ...target, handle })
      return { handle: result.handle, members: result.members, notes }
    } catch (error) {
      if (!isPeersError(error, 'handle_taken')) throw error
      const suggestion = suggestionOf(error, handle, attempt)
      if (choice.fixed) throw new HandleTakenError(handle, suggestion, sameMemberOf(error))
      if (attempt >= MAX_SUFFIX_TRIES) throw error
      notes.push(`@${handle} is taken in this room; using @${suggestion}`)
      handle = suggestion
    }
  }
}

export interface RoomJoinInput {
  readonly session: SessionHandle
  readonly roomId: string
  readonly code: string
  readonly choice: HandleChoice
  readonly membership: Membership
  /** A handle this machine remembers for the room (autojoin.json): held = already joined. */
  readonly ownsHandle: (handle: string) => boolean
}

async function rejoined(input: RoomJoinInput, handle: string): Promise<Joined> {
  const { members } = await input.session.peers(input.roomId)
  return {
    kind: 'joined',
    handle,
    members,
    grantCreated: false,
    rejoined: true,
    notes: [],
    membershipLine: 'already a member (no invite use)',
  }
}

/**
 * True when the handle is held by a live session of this very member. The hub answers
 * `handle_taken` both for another member and for this member's own live session (PROTOCOL §2.1);
 * a hub that says which (`same_member` in the error data) is believed, otherwise this machine's
 * memory of the handle (autojoin.json) decides.
 */
function heldByThisMember(input: RoomJoinInput, error: HandleTakenError): boolean {
  if (error.sameMember !== undefined) return error.sameMember
  return input.ownsHandle(error.handle)
}

/** Existing token: join by room id; with no grant, redeem with the token through `room.join`. */
async function joinWithToken(input: RoomJoinInput): Promise<Joined | AlreadyJoined> {
  try {
    const claimed = await claim(input.session, { room_id: input.roomId }, input.choice)
    const line = `already a member${input.membership.line} (no invite use)`
    return { kind: 'joined', ...claimed, grantCreated: false, rejoined: false, membershipLine: line }
  } catch (error) {
    if (error instanceof HandleTakenError && heldByThisMember(input, error))
      return {
        kind: 'already',
        handle: error.handle,
        membershipLine: `already a member${input.membership.line}`,
      }
    if (!isPeersError(error, 'forbidden')) throw error
  }
  const claimed = await claim(input.session, { invite_code: input.code }, input.choice)
  const line = `redeemed the invite with your existing membership${input.membership.line}`
  return { kind: 'joined', ...claimed, grantCreated: true, rejoined: false, membershipLine: line }
}

export async function joinRoom(input: RoomJoinInput): Promise<Joined | AlreadyJoined> {
  const held = input.session.view.rooms.find((room) => room.room_id === input.roomId)
  if (held) return rejoined(input, held.handle)
  if (!input.membership.fresh) return joinWithToken(input)
  const claimed = await claim(input.session, { room_id: input.roomId }, input.choice)
  return {
    kind: 'joined',
    ...claimed,
    grantCreated: true,
    rejoined: false,
    membershipLine: input.membership.line,
  }
}
