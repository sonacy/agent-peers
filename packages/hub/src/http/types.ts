/** Shared types for the HTTP layer (PROTOCOL §9): options, the Hono env and the per-hub context. */
import type { HubConfig } from '../config'
import type { HubContext } from '../hub'
import type { AdminQueries } from '../services/admin-queries'
import type { RateLimiter } from '../services/rate-limit'
import type { AdminSessions } from './admin-sessions'
import type { HttpSettings } from './settings'
import type { StreamRegistry } from './sse'

/** One embedded file: its bytes (or text) keyed by the path below the mount, e.g. `assets/app.js`. */
export type AssetBody = string | Uint8Array<ArrayBuffer> | Blob
export type AssetMap = ReadonlyMap<string, AssetBody> | Readonly<Record<string, AssetBody>>

/** Where an SPA comes from: a directory on disk or an injected asset map (the compiled binary). */
export interface StaticSource {
  readonly dir?: string
  readonly assets?: AssetMap
}

/** Requests per minute per client IP on the public endpoints. */
export interface RateLimits {
  readonly redeem: number
  readonly preview: number
  readonly register: number
  readonly login: number
}

export interface HttpOptions {
  /** The member dashboard SPA served under `/app/*`. */
  readonly dashboard?: StaticSource
  /** The operator SPA under `/admin` (defaults to the member dashboard source). */
  readonly admin?: StaticSource
  /** `owner/repo` hosting the GitHub Releases that `/install.sh` downloads from. */
  readonly releaseRepo?: string
  /** Trust `X-Forwarded-For` / `X-Forwarded-Proto` (only behind a reverse proxy you run). */
  readonly trustProxy?: boolean
  readonly rateLimits?: Partial<RateLimits>
  /** SSE keep-alive comment interval. */
  readonly sseKeepaliveMs?: number
  /** Operator cookie lifetime. */
  readonly adminCookieTtlMs?: number
  /** Shown in invite previews; defaults to the public URL's host. */
  readonly hubName?: string
}

export interface ResolvedHttpOptions {
  readonly dashboard: StaticSource | undefined
  readonly admin: StaticSource | undefined
  readonly releaseRepo: string
  readonly trustProxy: boolean
  readonly rateLimits: RateLimits
  readonly sseKeepaliveMs: number
  readonly adminCookieTtlMs: number
  readonly hubName: string | undefined
}

/** The parts of Bun's server the HTTP layer uses (both listeners provide them). */
export interface ServerPort {
  requestIP(request: Request): { readonly address: string } | null
  timeout(request: Request, seconds: number): void
}

export interface AppBindings {
  readonly server: ServerPort
}

export interface AppVariables {
  memberId: string
  webToken: string
}

export type AppEnv = { Bindings: AppBindings; Variables: AppVariables }

export interface Limiters {
  readonly redeem: RateLimiter
  readonly preview: RateLimiter
  readonly register: RateLimiter
  readonly login: RateLimiter
}

/** Everything a route module needs. */
export interface HttpContext {
  readonly hub: HubContext
  readonly config: HubConfig
  readonly options: ResolvedHttpOptions
  readonly settings: HttpSettings
  readonly limiters: Limiters
  readonly streams: StreamRegistry
  readonly adminSessions: AdminSessions
  readonly lookups: AdminQueries
  readonly startedAt: number
}
