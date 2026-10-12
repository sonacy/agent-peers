/** Hub URL handling and the transport rule of PROTOCOL §1. */

import { PeersError, WS_PATH } from '@agent-peers/protocol'

/** Accepts a hub origin (`https://hub`), an invite-style URL or a ws(s) endpoint; returns the `/v0/ws` URL. */
export function toWebSocketUrl(hubUrl: string): string {
  let url: URL
  try {
    url = new URL(hubUrl)
  } catch (error) {
    throw new PeersError('insecure_transport', `invalid hub URL: ${hubUrl}`, undefined, { cause: error })
  }
  const protocol = { 'http:': 'ws:', 'https:': 'wss:', 'ws:': 'ws:', 'wss:': 'wss:' }[url.protocol]
  if (!protocol) throw new PeersError('insecure_transport', `unsupported hub URL scheme: ${url.protocol}`)
  const path = url.protocol.startsWith('ws') && url.pathname !== '/' ? url.pathname : WS_PATH
  return `${protocol}//${url.host}${path}${url.search}`
}

function ipv4Octets(host: string): readonly number[] | undefined {
  const parts = host.split('.')
  if (parts.length !== 4) return undefined
  const octets = parts.map((p) => (/^\d{1,3}$/.test(p) ? Number(p) : Number.NaN))
  return octets.every((o) => o >= 0 && o <= 255) ? octets : undefined
}

/** Loopback, RFC 1918 and 100.64.0.0/10 (Tailscale) hosts, where plain `ws://` is allowed. */
export function isPrivateHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase()
  if (host === 'localhost' || host === '::1') return true
  const o = ipv4Octets(host)
  if (!o) return false
  const [a = -1, b = -1] = o
  return (
    a === 127 ||
    a === 10 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127)
  )
}

export function assertTransportAllowed(wsUrl: string, insecure: boolean): void {
  const url = new URL(wsUrl)
  if (url.protocol === 'wss:' || insecure || isPrivateHost(url.hostname)) return
  throw new PeersError(
    'insecure_transport',
    `refusing plain ws:// to ${url.hostname}: use wss:// or run with --insecure`,
  )
}
