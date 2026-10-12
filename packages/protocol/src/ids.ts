/** Identifiers: ULIDs (§1) and invite codes (§8). Uses Web Crypto, so it also runs in the browser. */
import { decodeTime, monotonicFactory, ulid as randomUlid } from 'ulid'
import { INVITE_CODE_LENGTH } from './constants'

/** Crockford base32, the alphabet of both ULIDs and invite codes. */
export const CROCKFORD_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
export const ULID_RE = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/
export const INVITE_CODE_RE = /^[0-9A-HJKMNP-TV-Z]{16}$/

/** A new ULID; `now` seeds the 48-bit timestamp (default `Date.now()`). */
export function ulid(now?: number): string {
  return randomUlid(now)
}

/** A generator whose ULIDs strictly increase, even within one millisecond. */
export function createUlidFactory(): (now?: number) => string {
  return monotonicFactory()
}

export function isUlid(value: unknown): value is string {
  return typeof value === 'string' && ULID_RE.test(value)
}

/** The Unix ms timestamp inside a ULID. */
export function ulidTime(id: string): number {
  return decodeTime(id)
}

/** A fresh 80-bit invite code: 16 Crockford base32 characters. */
export function createInviteCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(INVITE_CODE_LENGTH))
  return Array.from(bytes, (b) => CROCKFORD_ALPHABET.charAt(b & 31)).join('')
}

export function isInviteCode(value: unknown): value is string {
  return typeof value === 'string' && INVITE_CODE_RE.test(value)
}
