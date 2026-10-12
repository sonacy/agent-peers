/**
 * Member sign-in (DASHBOARD §1, ONBOARDING §1): `GET /app/login` renders a Continue button only (the
 * dashboard's own sign-in screen when it is bundled, else a plain server page); the
 * POST checks Origin, consumes the one-time `dashboard.login` code and sets the member cookie
 * (HttpOnly, SameSite=Strict, Secure under TLS, 7 days). The member API requires that cookie.
 */
import { LoginBodySchema, MEMBER_COOKIE_TTL_MS, PeersError } from '@agent-peers/protocol'
import type { Context, Hono, MiddlewareHandler } from 'hono'
import { getCookie } from 'hono/cookie'
import { body, isJson, NO_STORE, OK, readForm } from './errors'
import { html, htmlResponse, messagePage, page } from './html'
import {
  clearSessionCookie,
  isSecure,
  MEMBER_COOKIE,
  type OriginGuardOptions,
  rateLimit,
  requireOrigin,
  setSessionCookie,
} from './security'
import { serveSpaIndex } from './static'
import type { AppEnv, HttpContext } from './types'

const MAX_CODE_CHARS = 128

function loginPage(code: string | undefined): Response {
  if (code === undefined || code === '' || code.length > MAX_CODE_CHARS) {
    return htmlResponse(
      page(
        'Sign in · Peers',
        html`<h1>Sign in to Peers</h1><p>Open your agent and type <code>/peers:dashboard</code>. It brings you back here, signed in.</p>
<p class="muted">打开你的 agent，输入 /peers:dashboard，会自动带你回来。</p>`,
      ),
    )
  }
  return htmlResponse(
    page(
      'Sign in · Peers',
      html`<h1>Sign in to Peers</h1><p>Continue to open your dashboard in this browser.</p>
<form method="post" action="/app/login"><input type="hidden" name="code" value="${code}"><button type="submit">Continue</button></form>`,
    ),
  )
}

async function loginCode(c: Context<AppEnv>): Promise<{ readonly code: string; readonly form: boolean }> {
  if (isJson(c)) return { code: (await body(c, LoginBodySchema, 'invalid login body')).code, form: false }
  const form = await readForm(c)
  const code = form.code ?? form.c ?? ''
  if (code === '' || code.length > MAX_CODE_CHARS)
    throw new PeersError('invalid_params', 'missing login code')
  return { code, form: true }
}

async function login(ctx: HttpContext, c: Context<AppEnv>): Promise<Response> {
  const { code, form } = await loginCode(c)
  const { auth, queries } = ctx.hub.services
  let session: ReturnType<typeof auth.consumeLogin>
  try {
    session = auth.consumeLogin(code)
  } catch (error) {
    if (form && error instanceof PeersError && error.code === 'unauthorized') {
      return messagePage(
        'Link expired',
        'This sign-in link is invalid, used or expired. Run /peers:dashboard again.',
        401,
      )
    }
    throw error
  }
  const secure = isSecure(c, ctx.settings.publicUrl(), ctx.options.trustProxy)
  setSessionCookie(c, MEMBER_COOKIE, session.token, MEMBER_COOKIE_TTL_MS, secure)
  c.header('cache-control', NO_STORE)
  if (form) return c.redirect('/app/', 303)
  return c.json({ ok: true, member: queries.me(session.member_id) })
}

/** Resolves the member cookie; 401 `unauthorized` without a live web session. */
export function requireMember(ctx: HttpContext): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const token = getCookie(c, MEMBER_COOKIE)
    const memberId = token === undefined ? undefined : ctx.hub.services.auth.webSession(token)
    if (token === undefined || memberId === undefined || !ctx.hub.services.queries.me(memberId)) {
      throw new PeersError('unauthorized', 'sign in with /peers:dashboard')
    }
    c.set('memberId', memberId)
    c.set('webToken', token)
    await next()
  }
}

export function mountMemberAuth(app: Hono<AppEnv>, ctx: HttpContext, origin: OriginGuardOptions): void {
  // With the dashboard bundled, its sign-in screen (Chinese, styled, same Continue-only POST) renders
  // the page; GET never consumes the code either way.
  app.get(
    '/app/login',
    async (c) =>
      (await serveSpaIndex(ctx.options.dashboard)) ?? loginPage(c.req.query('c') ?? c.req.query('code')),
  )
  app.post(
    '/app/login',
    requireOrigin(origin),
    rateLimit(ctx.limiters.login, 'login', ctx.options.trustProxy),
    (c) => login(ctx, c),
  )
  app.post('/v0/me/logout', (c) => {
    const token = getCookie(c, MEMBER_COOKIE)
    if (token !== undefined) ctx.hub.services.auth.logout(token)
    clearSessionCookie(c, MEMBER_COOKIE, isSecure(c, ctx.settings.publicUrl(), ctx.options.trustProxy))
    return c.json(OK)
  })
}
