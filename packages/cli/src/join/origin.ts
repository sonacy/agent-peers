/**
 * How `join` shows the hub it is about to trust (ONBOARDING §3 step 1): the origin with its
 * registrable domain emphasised, internationalised names as punycode (WHATWG URL parsing already
 * converts them), and no user info, path or query.
 */
import { isPrivateHost } from '@agent-peers/core'
import { isLoopbackHost } from '@agent-peers/protocol'

/** Public suffixes with two labels that are common enough to matter (no full PSL in the binary). */
const TWO_LABEL_SUFFIXES: ReadonlySet<string> = new Set([
  'co.uk',
  'org.uk',
  'ac.uk',
  'gov.uk',
  'com.au',
  'net.au',
  'org.au',
  'co.jp',
  'ne.jp',
  'or.jp',
  'com.cn',
  'net.cn',
  'org.cn',
  'com.hk',
  'com.tw',
  'co.kr',
  'co.nz',
  'com.br',
  'co.in',
  'com.sg',
  'co.za',
  'com.mx',
  'github.io',
  'ts.net',
  'pages.dev',
  'workers.dev',
  'vercel.app',
  'netlify.app',
  'fly.dev',
  'herokuapp.com',
])

const isIpAddress = (host: string): boolean => /^[\d.]+$/.test(host) || host.includes(':')

/** `hub.payments.example.co.uk` → `example.co.uk`; IPs and single labels are returned as they are. */
export function registrableDomain(hostname: string): string {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase()
  if (isIpAddress(host)) return host
  const labels = host.split('.').filter(Boolean)
  if (labels.length <= 2) return labels.join('.')
  const lastTwo = labels.slice(-2).join('.')
  const keep = TWO_LABEL_SUFFIXES.has(lastTwo) ? 3 : 2
  return labels.slice(-keep).join('.')
}

export interface OriginView {
  readonly origin: string
  readonly hostname: string
  readonly registrable: string
  /** The host had internationalised labels, now shown as `xn--…`. */
  readonly punycode: boolean
  /** Loopback, LAN or tailnet: only reachable from this machine or network. */
  readonly local: boolean
}

export function describeOrigin(origin: string): OriginView {
  const url = new URL(origin)
  const hostname = url.hostname
  return {
    origin: `${url.protocol}//${url.host}`,
    hostname,
    registrable: registrableDomain(hostname),
    punycode: hostname.split('.').some((label) => label.startsWith('xn--')),
    local: isLoopbackHost(hostname) || isPrivateHost(hostname),
  }
}

/** `https://hub.[EXAMPLE.COM]:8443`: the registrable domain upper-cased inside brackets. */
export function emphasiseOrigin(view: OriginView): string {
  const url = new URL(view.origin)
  const host = view.hostname
  const port = url.port ? `:${url.port}` : ''
  if (host.startsWith('[')) return `${url.protocol}//${host}${port}`
  if (isIpAddress(host) || view.registrable === host) return `${url.protocol}//[${host.toUpperCase()}]${port}`
  const prefix = host.slice(0, host.length - view.registrable.length)
  return `${url.protocol}//${prefix}[${view.registrable.toUpperCase()}]${port}`
}
