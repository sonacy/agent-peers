/**
 * The hub's HTTP layer (PROTOCOL §9): Hono apps for the public listener (invites, registration,
 * landing page, installer, member dashboard and API) and the admin listener (operator API and SPA).
 */
import { REDEEMS_PER_MINUTE_PER_IP } from '@agent-peers/protocol'
import type { AdminServer, HttpMounts, HubContext, PublicServer } from '../hub'
import { createAdminQueries } from '../services/admin-queries'
import { createRateLimiter } from '../services/rate-limit'
import { createAdminSessions } from './admin-sessions'
import { createAdminApp, createPublicApp } from './apps'
import { DEFAULT_RELEASE_REPO, validateInstallInputs } from './install-script'
import { createSettings } from './settings'
import { createStreamRegistry } from './sse'
import type { HttpContext, HttpOptions, Limiters, RateLimits, ResolvedHttpOptions } from './types'

export { renderInstallScript } from './install-script'
export type { AssetBody, AssetMap, HttpOptions, RateLimits, StaticSource } from './types'

const MINUTE = 60_000
const DAY = 24 * 60 * MINUTE

export const DEFAULT_RATE_LIMITS: RateLimits = Object.freeze({
  redeem: REDEEMS_PER_MINUTE_PER_IP,
  preview: 30,
  register: 5,
  login: 20,
})

export function resolveHttpOptions(options: HttpOptions = {}): ResolvedHttpOptions {
  return Object.freeze({
    dashboard: options.dashboard,
    admin: options.admin,
    releaseRepo: options.releaseRepo ?? DEFAULT_RELEASE_REPO,
    trustProxy: options.trustProxy ?? false,
    rateLimits: Object.freeze({ ...DEFAULT_RATE_LIMITS, ...options.rateLimits }),
    sseKeepaliveMs: options.sseKeepaliveMs ?? 25_000,
    adminCookieTtlMs: options.adminCookieTtlMs ?? DAY,
    hubName: options.hubName,
  })
}

/** The HTTP mounts plus `close`, which ends open event streams when the hub stops. */
export interface HttpLayer extends Required<HttpMounts> {
  readonly context: HttpContext
}

export function createHttpMounts(hub: HubContext, input: HttpOptions = {}): HttpLayer {
  const options = resolveHttpOptions(input)
  const { clock } = hub.config
  validateInstallInputs(hub.config.version, options.releaseRepo)
  const limiter = (limit: number) => createRateLimiter(clock, limit, MINUTE)
  const limiters: Limiters = {
    redeem: limiter(options.rateLimits.redeem),
    preview: limiter(options.rateLimits.preview),
    register: limiter(options.rateLimits.register),
    login: limiter(options.rateLimits.login),
  }
  const context: HttpContext = {
    hub,
    config: hub.config,
    options,
    settings: createSettings(hub),
    limiters,
    streams: createStreamRegistry(),
    adminSessions: createAdminSessions(clock, options.adminCookieTtlMs),
    lookups: createAdminQueries(hub.services),
    startedAt: clock.now(),
  }
  const publicApp = createPublicApp(context)
  const adminApp = createAdminApp(context)
  return {
    context,
    public: (req: Request, server: PublicServer) => publicApp.fetch(req, { server }),
    admin: (req: Request, server: AdminServer) => adminApp.fetch(req, { server }),
    close: () => context.streams.closeAll(),
  }
}
