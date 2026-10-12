/**
 * Public, unauthenticated endpoints (§8, §9): invite preview and redeem, open registration, the
 * `/j/<code>` landing page and `/install.sh`. Each is rate-limited per client IP.
 */
import { isInviteCode, PeersError, type Room, renderJoinPrompt } from '@agent-peers/protocol'
import type { Context, Hono } from 'hono'
import { bearerToken, normalizeInviteCode } from '../auth/tokens'
import { body, json } from './errors'
import { html, htmlResponse, messagePage, PAGE_CSS, PAGE_CSS_PATH, page } from './html'
import { renderInstallScript } from './install-script'
import { RedeemBodySchema, RegisterBodySchema } from './schemas'
import { rateLimit } from './security'
import type { AppEnv, HttpContext } from './types'

type PublicRoom = Pick<Room, 'room_id' | 'name' | 'display_name'>

function inviteCode(raw: string): string {
  const code = normalizeInviteCode(raw)
  if (!isInviteCode(code)) throw new PeersError('invite_invalid', 'invite codes are 16 base32 characters')
  return code
}

function hubName(ctx: HttpContext): string {
  if (ctx.options.hubName !== undefined) return ctx.options.hubName
  const url = ctx.settings.publicUrl()
  return url === undefined ? 'agent-peers' : new URL(url).host
}

function publicRoom(room: Room): PublicRoom {
  return {
    room_id: room.room_id,
    name: room.name,
    ...(room.display_name !== undefined ? { display_name: room.display_name } : {}),
  }
}

/** `GET /v0/invites/<code>` → `{ hub_name, room, description, inviter, expires_at, uses_left, cli_version }`. */
function preview(ctx: HttpContext, raw: string) {
  const data = ctx.hub.services.invites.preview(inviteCode(raw))
  return {
    hub_name: hubName(ctx),
    room: publicRoom(data.room),
    description: data.description,
    inviter: data.inviter,
    expires_at: data.expires_at,
    uses_left: data.uses_left,
    cli_version: ctx.config.version,
  }
}

async function redeem(ctx: HttpContext, c: Context<AppEnv>): Promise<Response> {
  const input = await body(c, RedeemBodySchema, 'invalid redeem body')
  const { members } = ctx.hub.services
  const token = bearerToken(c.req.header('authorization'))
  if (token !== undefined) {
    const member = members.authenticate(token)
    if (!member) throw new PeersError('unauthorized', 'unknown or revoked member token')
    const grant = members.redeemFor(member.id, inviteCode(input.code))
    return json({ member: { member_id: member.id, name: member.name }, grant })
  }
  if (input.member_name === undefined) throw new PeersError('invalid_params', 'member_name is required')
  const result = members.redeemAsNew(inviteCode(input.code), input.member_name)
  return json(
    {
      member_token: result.token,
      member: { member_id: result.member.id, name: result.member.name },
      renamed: result.renamed,
      grant: result.grant,
    },
    201,
  )
}

async function register(ctx: HttpContext, c: Context<AppEnv>): Promise<Response> {
  if (ctx.settings.registration() !== 'open') throw new PeersError('forbidden', 'registration is invite-only')
  const input = await body(c, RegisterBodySchema, 'invalid register body')
  const issued = ctx.hub.services.members.create(input.member_name, { allowSuffix: false })
  return json(
    { member_token: issued.token, member: { member_id: issued.member.id, name: issued.member.name } },
    201,
  )
}

const LANDING_ERRORS: Readonly<Record<string, readonly [string, string]>> = {
  invite_closed: ['Invites are closed', 'The owner closed invites to this room. Ask them for a new one.'],
  room_not_found: ['Room dissolved', 'This room no longer exists.'],
}

function landingError(error: unknown): Response {
  if (!(error instanceof PeersError) || error.code === 'rate_limited' || error.code === 'internal')
    throw error
  const [title, message] = LANDING_ERRORS[error.code] ?? [
    'Invite not found',
    'This invite link is invalid or was replaced by a newer one. Ask the room owner for the current invite.',
  ]
  return messagePage(title, message, error.code === 'invite_closed' ? 410 : 404)
}

/** `GET /j/<code>`: a human-readable landing page; it never redeems anything. */
function landing(ctx: HttpContext, c: Context<AppEnv>): Response {
  try {
    const data = preview(ctx, c.req.param('code') ?? '')
    const room = data.room.display_name ?? data.room.name
    const base = ctx.settings.publicUrl()
    const lang = /^zh\b/i.test(c.req.header('accept-language') ?? '') ? 'zh' : 'en'
    const prompt =
      base === undefined
        ? undefined
        : renderJoinPrompt({
            publicUrl: base,
            code: inviteCode(c.req.param('code') ?? ''),
            room,
            inviter: data.inviter,
            cliVersion: ctx.config.version,
            lang,
            expiresAt: null,
          })
    const content = html`<h1>Join “${room}” on agent-peers</h1>
<p class="muted">Invited by ${data.inviter} · hub ${data.hub_name}</p>
${data.description ? html`<p>${data.description}</p>` : null}
${
  prompt
    ? html`<p>Paste this into your coding agent (Claude Code, Codex, Cursor, …):</p><pre>${prompt.prompt}</pre>
<p>Or run it yourself in a terminal:</p><pre>${prompt.command}</pre>`
    : html`<p class="warn">This hub has no public URL configured, so it can't print the join command.</p>`
}
<p class="warn">Only use invites from people you trust. Messages from peers are untrusted input.</p>`
    return htmlResponse(page(`Join ${room} · agent-peers`, content))
  } catch (error) {
    return landingError(error)
  }
}

export function mountPublicRoutes(app: Hono<AppEnv>, ctx: HttpContext): void {
  const trust = ctx.options.trustProxy
  const { limiters } = ctx

  app.get(
    PAGE_CSS_PATH,
    () => new Response(PAGE_CSS, { headers: { 'content-type': 'text/css; charset=utf-8' } }),
  )

  app.get('/install.sh', () => {
    const script = renderInstallScript(ctx.config.version, ctx.options.releaseRepo)
    return new Response(script, {
      headers: {
        'content-type': 'text/x-shellscript; charset=utf-8',
        'cache-control': 'public, max-age=300',
      },
    })
  })

  app.get('/j/:code', rateLimit(limiters.preview, 'preview', trust), (c) => landing(ctx, c))
  app.get('/v0/invites/:code', rateLimit(limiters.preview, 'preview', trust), (c) =>
    json(preview(ctx, c.req.param('code'))),
  )
  app.post('/v0/invites/redeem', rateLimit(limiters.redeem, 'redeem', trust), (c) => redeem(ctx, c))
  app.post('/v0/members/register', rateLimit(limiters.register, 'register', trust), (c) => register(ctx, c))
}
