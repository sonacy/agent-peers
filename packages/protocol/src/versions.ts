/** Protocol negotiation (§4, §11) and adapter version checks. */
import { PROTOCOL_PREFIX, SUPPORTED_PROTOCOLS } from './constants'

/** Compares dotted numeric versions ("0.2.10" > "0.2.9"). Pre-release suffixes are ignored. */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string) =>
    (v.split('-')[0] ?? '').split('.').map((part) => Number.parseInt(part, 10) || 0)
  const left = parse(a)
  const right = parse(b)
  const length = Math.max(left.length, right.length)
  for (let i = 0; i < length; i += 1) {
    const diff = (left[i] ?? 0) - (right[i] ?? 0)
    if (diff !== 0) return Math.sign(diff)
  }
  return 0
}

/** §4: sessions on a bridge whose adapter is older than the hub's `min_adapter` are `outdated`. */
export function isAdapterOutdated(adapter: string, minAdapter: string | undefined): boolean {
  return minAdapter !== undefined && compareVersions(adapter, minAdapter) < 0
}

/** `"agent-peers/0.3"` → `{ major: 0, minor: 3 }`; undefined when malformed. */
export function parseProtocol(value: string): { readonly major: number; readonly minor: number } | undefined {
  if (!value.startsWith(PROTOCOL_PREFIX)) return undefined
  const match = /^(\d+)\.(\d+)$/.exec(value.slice(PROTOCOL_PREFIX.length))
  return match ? { major: Number(match[1]), minor: Number(match[2]) } : undefined
}

/**
 * Picks the protocol for a `hello`: the first offered version we support exactly, else undefined
 * (the hub then answers `version_unsupported` with `data.supported`).
 */
export function negotiateProtocol(
  offered: readonly string[],
  supported: readonly string[] = SUPPORTED_PROTOCOLS,
): string | undefined {
  return offered.find((version) => supported.includes(version))
}
