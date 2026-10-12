/**
 * Operator auth on the admin listener (§9): `POST /v0/admin/login { token }` exchanges the admin
 * token for an HttpOnly, SameSite=Strict cookie. Scripts on the hub host (`agent-peers invite`) may
 * send `Authorization: Bearer <admin token>` instead. Tokens are never read from URLs.
 */
import { PeersError } from '@agent-peers/protocol'
import type { Context, Hono, MiddlewareHandler } from 'hono'
import { getCookie } from 'hono/cookie'
import { bearerToken } from '../auth/tokens'
import { body, json, OK } from './errors'
import { AdminLoginBodySchema } from './schemas'
import {
  ADMIN_COOKIE,
  clearSessionCookie,
  isSecure,
  type OriginGuardOptions,
  rateLimit,
  requireOrigin,
  setSessionCookie,
} from './security'
import type { AppEnv, HttpContext } from './types'

export const ADMIN_LOGIN_PATH = '/v0/admin/login'
export const ADMIN_LOGOUT_PATH = '/v0/admin/logout'
const OPEN_PATHS: ReadonlySet<string> = new Set([ADMIN_LOGIN_PATH, ADMIN_LOGOUT_PATH])

/** A predicate telling whether the caller's admin credential is still valid (for SSE). */
export type AdminCheck = () => boolean

/** Resolves the caller's admin credential, or undefined. */
export function adminCredential(ctx: HttpContext, c: Context<AppEnv>): AdminCheck | undefined {
  const bearer = bearerToken(c.req.header('authorization'))
  if (bearer !== undefined) {
    const check = () => ctx.hub.services.auth.verifyAdmin(bearer)
    return check() ? check : undefined
  }
  const cookie = getCookie(c, ADMIN_COOKIE)
  if (cookie === undefined) return undefined
  const check = () => ctx.adminSessions.valid(cookie)
  return check() ? check : undefined
}

export function requireAdmin(ctx: HttpContext): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    if (OPEN_PATHS.has(c.req.path) || !c.req.path.startsWith('/v0/admin/')) return next()
    if (!adminCredential(ctx, c)) throw new PeersError('unauthorized', 'sign in with the admin token')
    await next()
  }
}

export function startAdminSession(ctx: HttpContext, c: Context<AppEnv>): void {
  const secure = isSecure(c, undefined, ctx.options.trustProxy)
  setSessionCookie(c, ADMIN_COOKIE, ctx.adminSessions.open(), ctx.options.adminCookieTtlMs, secure)
}

async function login(ctx: HttpContext, c: Context<AppEnv>): Promise<Response> {
  const input = await body(c, AdminLoginBodySchema, 'invalid admin login')
  if (!ctx.hub.services.auth.verifyAdmin(input.token))
    throw new PeersError('unauthorized', 'wrong admin token')
  startAdminSession(ctx, c)
  return c.json(OK)
}

export function mountAdminAuth(app: Hono<AppEnv>, ctx: HttpContext, origin: OriginGuardOptions): void {
  app.post(
    ADMIN_LOGIN_PATH,
    requireOrigin(origin),
    rateLimit(ctx.limiters.login, 'admin-login', ctx.options.trustProxy),
    (c) => login(ctx, c),
  )
  app.post(ADMIN_LOGOUT_PATH, (c) => {
    const cookie = getCookie(c, ADMIN_COOKIE)
    if (cookie !== undefined) ctx.adminSessions.close(cookie)
    clearSessionCookie(c, ADMIN_COOKIE, isSecure(c, undefined, ctx.options.trustProxy))
    return c.json(OK)
  })
  app.get('/v0/admin/whoami', () => json({ admin: true }))
}
