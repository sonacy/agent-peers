/**
 * The two plain-HTTP calls `join` makes before it has a WebSocket (PROTOCOL §8, §9): the public
 * invite preview and the redeem for a caller without a token. Neither follows a redirect, and
 * every failure becomes a PeersError with the hub's own code (or a network error with its errno).
 */
import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import { hubOrigin, isPrivateHost } from '@agent-peers/core'
import { IdSchema, isErrorCode, isValidName, PeersError, RoomSchema } from '@agent-peers/protocol'

export type FetchFn = (input: string, init?: RequestInit) => Promise<Response>

/** `GET /v0/invites/<code>`; hub strings are kept short here and sanitized again when printed. */
export interface InvitePreview {
  readonly hub_name: string
  readonly room: { readonly room_id: string; readonly name: string; readonly display_name?: string }
  readonly inviter: string
  readonly description?: string
}

export interface RedeemResult {
  readonly member_token: string
  readonly member: { readonly name: string }
  readonly renamed: boolean
  readonly grant: { readonly room_id: string }
}

type Json = Readonly<Record<string, unknown>>

const isObject = (value: unknown): value is Json =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** A bounded string field, else undefined. */
function text(value: unknown, max: number): string | undefined {
  return typeof value === 'string' && value.length <= max ? value : undefined
}

/** Validates a preview body (the CLI has no zod of its own: protocol schemas plus small guards). */
export function parsePreview(body: unknown): InvitePreview | undefined {
  if (!isObject(body)) return undefined
  const room = RoomSchema.safeParse(body.room)
  const hubName = text(body.hub_name, 256)
  const inviter = text(body.inviter, 256)
  if (!room.success || hubName === undefined || inviter === undefined) return undefined
  const display = room.data.display_name
  const description = text(body.description, 1024)
  return {
    hub_name: hubName,
    room: { room_id: room.data.room_id, name: room.data.name, ...(display ? { display_name: display } : {}) },
    inviter,
    ...(description ? { description } : {}),
  }
}

export function parseRedeem(body: unknown): RedeemResult | undefined {
  if (!isObject(body) || !isObject(body.member) || !isObject(body.grant)) return undefined
  const token = text(body.member_token, 512)
  const name = body.member.name
  const roomId = IdSchema.safeParse(body.grant.room_id)
  if (!token || !isValidName(name) || !roomId.success) return undefined
  return {
    member_token: token,
    member: { name },
    renamed: body.renamed === true,
    grant: { room_id: roomId.data },
  }
}

function errorOf(body: unknown): { readonly code: string; readonly message?: string } | undefined {
  if (!isObject(body) || !isObject(body.error) || typeof body.error.code !== 'string') return undefined
  const message = text(body.error.message, 1024)
  return { code: body.error.code, ...(message ? { message } : {}) }
}

/** A request that never reached the hub; `code` is the errno-style code when the runtime gave one. */
export class NetworkError extends Error {
  override readonly name = 'NetworkError'
  constructor(
    message: string,
    readonly code: string | undefined,
  ) {
    super(message)
  }
}

function errnoOf(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined
  const code = (error as { code?: unknown }).code
  if (typeof code === 'string') return code
  return errnoOf((error as { cause?: unknown }).cause)
}

/** Resolves a host name; rejects with the resolver's errno code (ENOTFOUND, EAI_AGAIN, EPERM…). */
export type LookupFn = (hostname: string) => Promise<unknown>

const isErrno = (code: string | undefined): boolean => code !== undefined && /^E[A-Z_]+$/.test(code)

/**
 * The errno behind a failed request. Bun's fetch reports a failed DNS lookup as `ConnectionRefused`,
 * so a non-errno failure on a host name is followed by a lookup: its errno (ENOTFOUND under a
 * sandbox that blocks the network) is the real cause. IP literals and errno failures are kept.
 */
export async function failureCode(
  error: unknown,
  hostname: string,
  resolve: LookupFn = lookup,
): Promise<string | undefined> {
  const code = errnoOf(error)
  const bare = hostname.replace(/^\[|\]$/g, '')
  if (isErrno(code) || isIP(bare) !== 0) return code
  try {
    await resolve(bare)
    return code
  } catch (lookupError) {
    const resolved = errnoOf(lookupError)
    return isErrno(resolved) ? resolved : code
  }
}

/** PROTOCOL §1 / §8: plain http:// only to loopback, LAN and tailnet hosts, unless `--insecure`. */
export function assertHttpAllowed(origin: string, insecure: boolean): void {
  const url = new URL(hubOrigin(origin))
  if (url.protocol === 'https:' || insecure || isPrivateHost(url.hostname)) return
  throw new PeersError(
    'insecure_transport',
    `refusing plain http:// to ${url.hostname}: use an https:// invite link or --insecure`,
  )
}

async function readBody(response: Response): Promise<unknown> {
  try {
    return await response.json()
  } catch {
    return undefined
  }
}

async function requestJson(fetchFn: FetchFn, url: string, init: RequestInit): Promise<unknown> {
  let response: Response
  try {
    response = await fetchFn(url, { ...init, redirect: 'manual' })
  } catch (error) {
    const { host, hostname } = new URL(url)
    const code = await failureCode(error, hostname)
    const dns = code !== undefined && code !== errnoOf(error) ? ` (DNS lookup: ${code})` : ''
    throw new NetworkError(
      `cannot reach ${host}: ${error instanceof Error ? error.message : String(error)}${dns}`,
      code,
    )
  }
  if (response.status >= 300 && response.status < 400)
    throw new PeersError('invite_invalid', `the hub answered with a redirect (HTTP ${response.status})`)
  const body = await readBody(response)
  if (response.ok) return body
  const failure = errorOf(body)
  if (failure && isErrorCode(failure.code))
    throw new PeersError(failure.code, failure.message ?? failure.code)
  throw new PeersError('internal', `the hub answered HTTP ${response.status}`)
}

export async function fetchPreview(fetchFn: FetchFn, origin: string, code: string): Promise<InvitePreview> {
  const body = await requestJson(fetchFn, `${hubOrigin(origin)}/v0/invites/${code}`, {
    method: 'GET',
    headers: { accept: 'application/json' },
  })
  const parsed = parsePreview(body)
  if (!parsed) throw new PeersError('invalid_result', 'the hub sent an invalid invite preview')
  return parsed
}

/** `POST /v0/invites/redeem { code, member_name }` as a new member; never sends an existing token. */
export async function redeemAsNewMember(
  fetchFn: FetchFn,
  origin: string,
  code: string,
  memberName: string,
): Promise<RedeemResult> {
  const body = await requestJson(fetchFn, `${hubOrigin(origin)}/v0/invites/redeem`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code, member_name: memberName }),
  })
  const parsed = parseRedeem(body)
  if (!parsed) throw new PeersError('invalid_result', 'the hub sent an invalid redeem response')
  return parsed
}
