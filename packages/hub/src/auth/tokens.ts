/**
 * Secrets (§8): member/admin/web-session tokens, invite codes and dashboard login codes.
 * The hub stores only SHA-256 hashes; comparisons are constant time.
 */
import { CROCKFORD_ALPHABET, INVITE_CODE_LENGTH } from '@agent-peers/protocol'

const TOKEN_BYTES = 32
const LOGIN_CODE_LENGTH = 24

export type TokenKind = 'member' | 'admin' | 'web'

const PREFIX: Readonly<Record<TokenKind, string>> = { member: 'apm_', admin: 'apa_', web: 'apw_' }

function base64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64url')
}

/** A fresh 256-bit token, prefixed by kind so leaked tokens are recognizable. */
export function generateToken(kind: TokenKind): string {
  return `${PREFIX[kind]}${base64url(crypto.getRandomValues(new Uint8Array(TOKEN_BYTES)))}`
}

export function sha256Hex(value: string): string {
  return new Bun.CryptoHasher('sha256').update(value).digest('hex')
}

export function hmacSha256(key: string, value: string): Uint8Array {
  return new Uint8Array(new Bun.CryptoHasher('sha256', key).update(value).digest())
}

/** Constant-time string comparison (length is not secret). */
export function constantTimeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8')
  const right = Buffer.from(b, 'utf8')
  if (left.length !== right.length) return false
  return crypto.timingSafeEqual(left, right)
}

/** Encodes the low 5 bits of each byte as Crockford base32. */
function base32(bytes: Uint8Array, length: number): string {
  return Array.from(bytes.slice(0, length), (b) => CROCKFORD_ALPHABET.charAt(b & 31)).join('')
}

/** A random 80-bit invite code: 16 Crockford base32 characters. */
export function generateInviteCode(): string {
  return base32(crypto.getRandomValues(new Uint8Array(INVITE_CODE_LENGTH)), INVITE_CODE_LENGTH)
}

/**
 * The invite code for an invite row, derived from the hub's invite secret. The database keeps only
 * the code's hash and last four characters, yet the hub can re-render the owner's join prompt.
 */
export function deriveInviteCode(secret: string, inviteId: string): string {
  return base32(hmacSha256(secret, `invite:${inviteId}`), INVITE_CODE_LENGTH)
}

/** Normalizes user-typed invite codes (case, Crockford look-alikes). */
export function normalizeInviteCode(code: string): string {
  return code.trim().toUpperCase().replace(/O/g, '0').replace(/[IL]/g, '1')
}

/** A one-time dashboard login code (120 bits, base32). */
export function generateLoginCode(): string {
  return base32(crypto.getRandomValues(new Uint8Array(LOGIN_CODE_LENGTH)), LOGIN_CODE_LENGTH)
}

/** A random secret for deriving invite codes. */
export function generateSecret(): string {
  return base64url(crypto.getRandomValues(new Uint8Array(TOKEN_BYTES)))
}

/** Reads `Authorization: Bearer <token>`; undefined when missing or malformed. */
export function bearerToken(header: string | null | undefined): string | undefined {
  const match = /^Bearer\s+([A-Za-z0-9._~+/=-]{8,512})\s*$/i.exec(header ?? '')
  return match?.[1]
}
