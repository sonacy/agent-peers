/** The two Hono apps: the public listener (bridges, invites, member dashboard) and the admin listener. */
import { PeersError } from '@agent-peers/protocol'
import { type Context, Hono, type MiddlewareHandler } from 'hono'
import { mountAdminAuth, requireAdmin } from './admin-auth'
import { mountAdminReads } from './admin-read'
import { mountAdminWrites } from './admin-write'
import { errorResponse } from './errors'
import { PAGE_CSS, PAGE_CSS_PATH } from './html'
import { mountMemberAuth, requireMember } from './member-auth'
import { mountMemberReads } from './member-read'
import { mountMemberWrites } from './member-write'
import { mountPublicRoutes } from './public-routes'
import {
  ADMIN_COOKIE,
  localHostOnly,
  MEMBER_COOKIE,
  type OriginGuardOptions,
  originGuard,
  securityHeaders,
} from './security'
import { serveSpa } from './static'
import type { AppEnv, HttpContext } from './types'

const MEMBER_API = /^\/v0\/me(\/|$)|^\/v0\/rooms\/search$/
const MEMBER_OPEN: ReadonlySet<string> = new Set(['/v0/me/logout'])

function base(ctx: HttpContext, origin: OriginGuardOptions): Hono<AppEnv> {
  const app = new Hono<AppEnv>()
  app.use('*', securityHeaders)
  app.use('*', originGuard(origin))
  app.onError((error) => errorResponse(error, ctx.config.logger))
  app.notFound((c: Context<AppEnv>) =>
    c.req.path.startsWith('/v0/')
      ? errorResponse(new PeersError('method_not_found', 'no such endpoint'), ctx.config.logger)
      : c.text('not found', 404),
  )
  return app
}

/** The member cookie gate for `/v0/me/*` and `/v0/rooms/search`. */
function memberGate(ctx: HttpContext): MiddlewareHandler<AppEnv> {
  const require = requireMember(ctx)
  return async (c, next) => {
    if (MEMBER_API.test(c.req.path) && !MEMBER_OPEN.has(c.req.path)) return require(c, next)
    await next()
  }
}

export function createPublicApp(ctx: HttpContext): Hono<AppEnv> {
  const origin: OriginGuardOptions = { publicUrl: () => ctx.settings.publicUrl(), cookies: [MEMBER_COOKIE] }
  const app = base(ctx, origin)
  app.use('*', memberGate(ctx))
  mountPublicRoutes(app, ctx)
  mountMemberAuth(app, ctx, origin)
  mountMemberReads(app, ctx)
  mountMemberWrites(app, ctx)
  app.get('/app', (c) => c.redirect('/app/', 301))
  app.get('/app/*', (c) => serveSpa(ctx.options.dashboard, '/app', c.req.path, 'Peers'))
  return app
}

export function createAdminApp(ctx: HttpContext): Hono<AppEnv> {
  const origin: OriginGuardOptions = { publicUrl: () => undefined, cookies: [ADMIN_COOKIE] }
  const app = base(ctx, origin)
  app.use('*', localHostOnly)
  app.use('*', requireAdmin(ctx))
  mountAdminAuth(app, ctx, origin)
  mountAdminReads(app, ctx)
  mountAdminWrites(app, ctx)
  app.get('/', (c) => c.redirect('/admin/', 302))
  app.get('/admin', (c) => c.redirect('/admin/', 301))
  app.get('/admin/*', (c) =>
    serveSpa(ctx.options.admin ?? ctx.options.dashboard, '/admin', c.req.path, 'Peers operator'),
  )
  app.get(PAGE_CSS_PATH, (c) => c.body(PAGE_CSS, 200, { 'content-type': 'text/css; charset=utf-8' }))
  return app
}
