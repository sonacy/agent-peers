/**
 * Dashboard and operator auth: `dashboard.login` one-time codes (5 minutes, single use), member web
 * sessions (7-day cookies, hashed), and the hashed admin token (§8, §9, ONBOARDING §1).
 */
import { DASHBOARD_LOGIN_TTL_MS, MEMBER_COOKIE_TTL_MS, PeersError } from '@agent-peers/protocol'
import { constantTimeEqual, generateLoginCode, generateToken, sha256Hex } from '../auth/tokens'
import type { Access } from './access'
import type { ServiceDeps } from './context'

export interface LoginLink {
  readonly code: string
  readonly url: string
  readonly expires_at: number
}

export interface WebSession {
  readonly token: string
  readonly member_id: string
  readonly expires_at: number
}

export function createAuth(deps: ServiceDeps, access: Access) {
  const { repos } = deps

  /** `dashboard.login`: a one-time, owner-scoped code and the URL that renders the Continue button. */
  const createLogin = (sessionId: string): LoginLink =>
    deps.tx(() => {
      const session = access.requireSession(sessionId)
      const base = deps.runtime.publicUrl
      if (base === undefined) throw new PeersError('forbidden', 'the dashboard needs --public-url')
      const code = generateLoginCode()
      const expires = deps.now() + DASHBOARD_LOGIN_TTL_MS
      repos.loginCodes.insert({
        code_hash: sha256Hex(code),
        member_id: session.member_id,
        created_at: deps.now(),
        expires_at: expires,
      })
      return { code, url: `${base}/app/login?c=${code}`, expires_at: expires }
    })

  /** Consumes a login code (the POST, after the Origin check) and opens a member web session. */
  const consumeLogin = (code: string): WebSession =>
    deps.tx(() => {
      const hash = sha256Hex(code.trim().toUpperCase())
      const row = repos.loginCodes.get(hash)
      if (!row || !repos.loginCodes.consume(hash, deps.now())) {
        throw new PeersError('unauthorized', 'this login link is invalid, used or expired')
      }
      return openWebSession(row.member_id)
    })

  const openWebSession = (memberId: string): WebSession => {
    const token = generateToken('web')
    const expires = deps.now() + MEMBER_COOKIE_TTL_MS
    repos.webSessions.insert({
      token_hash: sha256Hex(token),
      member_id: memberId,
      created_at: deps.now(),
      expires_at: expires,
    })
    return { token, member_id: memberId, expires_at: expires }
  }

  /** The member behind a web-session cookie; undefined when unknown or expired. */
  const webSession = (token: string): string | undefined => {
    const row = repos.webSessions.get(sha256Hex(token))
    return row && row.expires_at > deps.now() ? row.member_id : undefined
  }

  const logout = (token: string): void => repos.webSessions.delete(sha256Hex(token))

  const verifyAdmin = (token: string): boolean => {
    const row = repos.admin.get()
    return row !== undefined && constantTimeEqual(sha256Hex(token), row.token_hash)
  }

  /** Replaces the admin token (`agent-peers hub rotate-admin-token`); returns the new token once. */
  const rotateAdmin = (): string => {
    const token = generateToken('admin')
    repos.admin.set(sha256Hex(token), deps.now())
    return token
  }

  return { createLogin, consumeLogin, openWebSession, webSession, logout, verifyAdmin, rotateAdmin }
}
export type Auth = ReturnType<typeof createAuth>
