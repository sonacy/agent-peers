/** Member, handle and room-name rules (PROTOCOL §2): `^[a-z0-9][a-z0-9_-]{0,31}$`. */
import { MAX_NAME_LENGTH } from './constants'
import { PeersError } from './errors'

export const NAME_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/

export function isValidName(value: unknown): value is string {
  return typeof value === 'string' && NAME_RE.test(value)
}

/** FNV-1a 32-bit: a tiny deterministic hash for slug fallbacks (not for security). */
function fnv1a(text: string): number {
  let hash = 0x811c9dc5
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash
}

function slugify(input: string): string {
  return input
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[-_]+/, '')
    .slice(0, MAX_NAME_LENGTH)
    .replace(/[-_]+$/, '')
}

/**
 * Derives a valid name from free text: "Payments Team" → "payments-team", "Café" → "cafe".
 * Input with no usable Latin letters or digits (e.g. CJK "支付联调") falls back to a deterministic
 * `<prefix>-<hash>` slug, so the same display name always yields the same slug.
 */
export function toNameSlug(input: string, fallbackPrefix = 'room'): string {
  const slug = slugify(input)
  if (isValidName(slug)) return slug
  const prefix = slugify(fallbackPrefix).slice(0, 16) || 'x'
  return `${prefix}-${fnv1a(input.normalize('NFC')).toString(36)}`
}

/** `suffixName("alice", 2)` → `"alice-2"`, trimming the base so the result stays ≤ 32 characters. */
export function suffixName(base: string, n: number): string {
  if (!isValidName(base)) throw new PeersError('invalid_name', `not a valid name: ${JSON.stringify(base)}`)
  if (!Number.isInteger(n) || n < 1) throw new PeersError('invalid_params', `invalid suffix: ${n}`)
  const suffix = `-${n}`
  const head = base.slice(0, MAX_NAME_LENGTH - suffix.length).replace(/[-_]+$/, '')
  return `${head || base.charAt(0)}${suffix}`
}

/** First free name among `base`, `base-2`, `base-3`, … (§2.1 default handle on conflict). */
export function nextFreeName(base: string, isTaken: (name: string) => boolean, maxTries = 1000): string {
  if (!isTaken(base)) {
    if (!isValidName(base)) throw new PeersError('invalid_name', `not a valid name: ${JSON.stringify(base)}`)
    return base
  }
  for (let n = 2; n <= maxTries; n += 1) {
    const candidate = suffixName(base, n)
    if (!isTaken(candidate)) return candidate
  }
  throw new PeersError('handle_taken', `no free name for ${base} after ${maxTries} tries`)
}
