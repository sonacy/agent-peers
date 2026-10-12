/**
 * Browser-facing safety rules (§9): security headers with `Content-Security-Policy: default-src 'self'`,
 * the Origin check on mutations, per-IP rate limits and session cookies.
 */
import { PeersError } from '@agent-peers/protocol'
import type { Context, MiddlewareHandler } from 'hono'
import { deleteCookie, getCookie, setCookie } from 'hono/cookie'
import type { RateLimiter } from '../services/rate-limit'
import type { AppEnv } from './types'

export const CSP =
  "default-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; object-src 'none'"

export const MEMBER_COOKIE = 'ap_member'
export const ADMIN_COOKIE = 'ap_admin'

const SAFE_METHODS: ReadonlySet<string> = new Set(['GET', 'HEAD', 'OPTIONS'])

/** Security headers on every response; the CSP covers HTML pages and API responses alike. */
export const securityHeaders: MiddlewareHandler<AppEnv> = async (c, next) => {
  await next()
  const headers = c.res.headers
  headers.set('content-security-policy', CSP)
  headers.set('x-content-type-options', 'nosniff')
  // `same-origin`, not `no-referrer`: under `no-referrer` browsers send `Origin: null` on POSTs,
  // which the Origin check would refuse. Login codes in URLs still never leave this origin.
  headers.set('referrer-policy', 'same-origin')
  headers.set('x-frame-options', 'DENY')
  headers.set('cross-origin-opener-policy', 'same-origin')
}

function originOf(url: string | undefined): string | undefined {
  if (url === undefined) return undefined
  try {
    return new URL(url).origin
  } catch {
    return undefined
  }
}

/** The Origin matches this listener (by Host) or the configured public URL. */
export function originMatches(
  origin: string,
  host: string | undefined,
  publicUrl: string | undefined,
): boolean {
  let parsed: URL
  try {
    parsed = new URL(origin)
  } catch {
    return false
  }
  if (!/^https?:$/.test(parsed.protocol)) return false
  if (host !== undefined && parsed.host.toLowerCase() === host.toLowerCase()) return true
  return originOf(publicUrl) === parsed.origin
}

export interface OriginGuardOptions {
  /** The configured public URL, read per request (it can change at runtime). */
  readonly publicUrl: () => string | undefined
  /** Cookie names whose presence makes the request a browser session. */
  readonly cookies: readonly string[]
}

/**
 * Every mutation must carry a matching Origin. A request may omit it only when it carries none of
 * our session cookies: CLI and bridge calls authenticate with a header or not at all, so there is
 * no ambient browser credential to forge. A present but foreign Origin is always refused.
 */
export function originGuard(options: OriginGuardOptions): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    if (!SAFE_METHODS.has(c.req.method)) checkOrigin(c, options, false)
    await next()
  }
}

export function checkOrigin(c: Context<AppEnv>, options: OriginGuardOptions, required: boolean): void {
  const origin = c.req.header('origin')
  if (origin === undefined) {
    const hasCookie = options.cookies.some((name) => getCookie(c, name) !== undefined)
    if (required || hasCookie) throw new PeersError('forbidden', 'missing Origin header')
    return
  }
  if (!originMatches(origin, c.req.header('host'), options.publicUrl())) {
    throw new PeersError('forbidden', 'cross-origin request refused')
  }
}

/** Middleware form of a required Origin check (login forms, which carry no cookie yet). */
export function requireOrigin(options: OriginGuardOptions): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    checkOrigin(c, options, true)
    await next()
  }
}

const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/

/** True for `localhost`, `*.localhost` and IP literals: the only Host values the admin listener accepts. */
export function isLocalOrIpHost(hostHeader: string | undefined): boolean {
  if (hostHeader === undefined) return false
  let hostname: string
  try {
    hostname = new URL(`http://${hostHeader}`).hostname.toLowerCase()
  } catch {
    return false
  }
  if (hostname === 'localhost' || hostname.endsWith('.localhost')) return true
  return IPV4.test(hostname) || (hostname.startsWith('[') && hostname.endsWith(']'))
}

/**
 * Refuses requests whose Host is a DNS name: a page on another site can rebind its own name to
 * 127.0.0.1, and its requests would then look same-origin to a loopback listener.
 */
export const localHostOnly: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (!isLocalOrIpHost(c.req.header('host'))) throw new PeersError('forbidden', 'unexpected Host header')
  await next()
}

const FORWARDED_ADDRESS = /^[0-9A-Fa-f:.[\]]{2,64}$/

/**
 * The address a trusted proxy appended to `X-Forwarded-For`: the rightmost entry. Entries to its
 * left come from the client and can be forged, so they are never used for rate-limit keys.
 */
export function forwardedFor(header: string | undefined): string | undefined {
  const last = header?.split(',').at(-1)?.trim()
  return last !== undefined && FORWARDED_ADDRESS.test(last) ? last : undefined
}

/** The caller's IP: the socket address, or the proxy-appended `X-Forwarded-For` hop behind a trusted proxy. */
export function clientIp(c: Context<AppEnv>, trustProxy: boolean): string {
  if (trustProxy) {
    const forwarded = forwardedFor(c.req.header('x-forwarded-for'))
    if (forwarded) return forwarded
  }
  return c.env.server.requestIP(c.req.raw)?.address ?? 'unknown'
}

export function rateLimit(
  limiter: RateLimiter,
  bucket: string,
  trustProxy: boolean,
): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    limiter.enforce(`${bucket}:${clientIp(c, trustProxy)}`, 'requests from this address')
    await next()
  }
}

/** True when the browser reached us over TLS (directly, via the public URL, or a trusted proxy). */
export function isSecure(c: Context<AppEnv>, publicUrl: string | undefined, trustProxy: boolean): boolean {
  if (new URL(c.req.url).protocol === 'https:') return true
  if (trustProxy && c.req.header('x-forwarded-proto') === 'https') return true
  return publicUrl?.startsWith('https:') === true
}

/** HttpOnly, SameSite=Strict, Path=/, Secure under TLS. */
export function setSessionCookie(
  c: Context<AppEnv>,
  name: string,
  value: string,
  ttlMs: number,
  secure: boolean,
): void {
  setCookie(c, name, value, {
    httpOnly: true,
    sameSite: 'Strict',
    path: '/',
    secure,
    maxAge: Math.floor(ttlMs / 1000),
  })
}

export function clearSessionCookie(c: Context<AppEnv>, name: string, secure: boolean): void {
  deleteCookie(c, name, { path: '/', httpOnly: true, sameSite: 'Strict', secure })
}
