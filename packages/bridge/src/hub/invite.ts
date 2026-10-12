/**
 * Invite parsing and HTTP redemption (PROTOCOL §8 "Invites"): the code is the last path segment of
 * `<public_url>/j/<code>` and the hub base is the URL origin. Without a token for that hub the bridge
 * redeems through `POST /v0/invites/redeem { code, member_name }`, which returns the member token.
 */
import { hubOrigin, isPrivateHost } from '@agent-peers/core'
import { isErrorCode, isInviteCode, isValidName, PeersError } from '@agent-peers/protocol'
import { z } from 'zod'

export type InviteRef =
  | { readonly kind: 'url'; readonly hub: string; readonly code: string }
  | { readonly kind: 'code'; readonly code: string }
  | { readonly kind: 'room'; readonly room: string }

/** Codes are shown in groups or lower case sometimes: drop separators and upper-case. */
export const normalizeCode = (raw: string): string => raw.replace(/[\s-]/g, '').toUpperCase()

function parseUrl(text: string): InviteRef {
  let url: URL
  try {
    url = new URL(text)
  } catch {
    throw new PeersError('invite_invalid', 'not a valid invite link')
  }
  const segments = url.pathname.split('/').filter((s) => s.length > 0)
  const code = normalizeCode(segments.at(-1) ?? '')
  if (segments.at(-2) !== 'j' || !isInviteCode(code))
    throw new PeersError('invite_invalid', 'invite links look like https://<hub>/j/<16-character code>')
  return { kind: 'url', hub: hubOrigin(url.origin), code }
}

/** An invite URL, a bare invite code, or the name of a room this member already belongs to. */
export function parseInvite(input: string): InviteRef {
  const text = input.trim()
  if (/^https?:\/\//i.test(text)) return parseUrl(text)
  const code = normalizeCode(text)
  if (isInviteCode(code)) return { kind: 'code', code }
  const room = text.replace(/^#/, '').toLowerCase()
  if (isValidName(room)) return { kind: 'room', room }
  throw new PeersError('invite_invalid', 'expected an invite link, an invite code or a room name')
}

const RedeemResponseSchema = z.object({
  member_token: z.string().min(1),
  member: z.object({ name: z.string() }),
  renamed: z.boolean().optional(),
  grant: z.object({ room_id: z.string().min(1) }).loose(),
})
export type RedeemResponse = z.infer<typeof RedeemResponseSchema>

const ErrorBodySchema = z.object({
  error: z.object({ code: z.string(), message: z.string().optional() }),
})

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json()
  } catch {
    return undefined
  }
}

function httpError(response: Response, body: unknown): PeersError {
  const parsed = ErrorBodySchema.safeParse(body)
  if (parsed.success && isErrorCode(parsed.data.error.code))
    return new PeersError(parsed.data.error.code, parsed.data.error.message ?? parsed.data.error.code)
  return new PeersError('internal', `the hub answered HTTP ${response.status}`)
}

/**
 * PROTOCOL §1 / ARCHITECTURE §8: plain HTTP only to loopback, LAN and tailnet hosts (or with
 * `--insecure` / AGENT_PEERS_INSECURE=1). The invite code and the returned member token must never
 * cross the internet in clear text.
 */
export function assertRedeemTransport(hub: string, insecure: boolean): void {
  const url = new URL(hubOrigin(hub))
  if (url.protocol === 'https:' || insecure || isPrivateHost(url.hostname)) return
  throw new PeersError(
    'insecure_transport',
    `refusing to redeem an invite over plain http:// to ${url.hostname}: use an https:// link or --insecure`,
  )
}

export interface RedeemOptions {
  /** Allow plain http:// to public hosts. */
  readonly insecure?: boolean
}

/** Redeems an invite as a new member of `hub`. Never sends any existing token, never follows redirects. */
export async function redeemInvite(
  fetchFn: FetchLike,
  hub: string,
  code: string,
  memberName: string,
  options: RedeemOptions = {},
): Promise<RedeemResponse> {
  assertRedeemTransport(hub, options.insecure === true)
  let response: Response
  try {
    response = await fetchFn(`${hubOrigin(hub)}/v0/invites/redeem`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code, member_name: memberName }),
      // A redirect would carry the code (and get the token) to another origin.
      redirect: 'error',
    })
  } catch (error) {
    throw new PeersError('disconnected', `cannot reach ${new URL(hub).host}: ${String(error)}`)
  }
  const body = await readJson(response)
  if (response.status >= 300 && response.status < 400)
    throw new PeersError('invite_invalid', `the hub answered with a redirect (HTTP ${response.status})`)
  if (!response.ok) throw httpError(response, body)
  const parsed = RedeemResponseSchema.safeParse(body)
  if (!parsed.success) throw new PeersError('invalid_result', 'the hub sent an invalid redeem response')
  return parsed.data
}
