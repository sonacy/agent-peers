/**
 * Operator web sessions (§9): the admin token is exchanged for a random cookie value. Only hashes are
 * kept, in memory, so a hub restart or an admin-token rotation signs every browser out.
 */
import { generateToken, sha256Hex } from '../auth/tokens'
import type { Clock } from '../clock'

export interface AdminSessions {
  /** Opens a session; returns the cookie value. */
  open(): string
  valid(token: string): boolean
  close(token: string): void
  clear(): void
}

export function createAdminSessions(clock: Clock, ttlMs: number): AdminSessions {
  let sessions: ReadonlyMap<string, number> = new Map()
  const live = () => new Map([...sessions].filter(([, expires]) => expires > clock.now()))
  return {
    open() {
      const token = generateToken('web')
      sessions = new Map([...live(), [sha256Hex(token), clock.now() + ttlMs]])
      return token
    },
    valid(token) {
      const expires = sessions.get(sha256Hex(token))
      return expires !== undefined && expires > clock.now()
    },
    close(token) {
      const hash = sha256Hex(token)
      sessions = new Map([...live()].filter(([key]) => key !== hash))
    },
    clear() {
      sessions = new Map()
    },
  }
}
