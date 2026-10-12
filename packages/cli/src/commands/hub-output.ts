/**
 * What `agent-peers hub` prints once it listens: listeners, data dir, public URL, warnings about
 * invite reachability (PROTOCOL §9, ARCHITECTURE §7) and, on the first start, the bootstrap invite.
 */
import { networkInterfaces } from 'node:os'
import { isLoopbackHost, PROTOCOL_VERSION } from '@agent-peers/protocol'
import type { HubSettings } from './hub-options'
import { adminTokenPath } from './hub-state'

export interface StartedHub {
  readonly version: string
  readonly settings: HubSettings
  readonly publicPort: number
  readonly adminPort: number
  readonly publicUrl: string | undefined
  readonly dashboard: boolean
  /** The `default` room's invite on the first start. */
  readonly bootstrap?: { readonly inviteUrl: string; readonly joinPrompt: string | undefined }
}

const WILDCARDS: ReadonlySet<string> = new Set(['0.0.0.0', '::', ''])

export function hostForUrl(host: string): string {
  return host.includes(':') ? `[${host}]` : host
}

/** The address a local client dials for a listener bound to `bind`. */
export function dialHost(bind: string): string {
  return WILDCARDS.has(bind) ? '127.0.0.1' : bind
}

export function isLoopbackBindHost(bind: string): boolean {
  return !WILDCARDS.has(bind) && isLoopbackHost(bind)
}

/** A private IPv4 address of this machine, to suggest a LAN `--public-url`. */
export function lanAddress(
  interfaces: ReturnType<typeof networkInterfaces> = networkInterfaces(),
): string | undefined {
  const all = Object.values(interfaces).flatMap((list) => list ?? [])
  const v4 = all.filter((entry) => entry.family === 'IPv4' && !entry.internal)
  const isPrivate = (address: string) => /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(address)
  return (v4.find((entry) => isPrivate(entry.address)) ?? v4[0])?.address
}

export function hubWarnings(
  started: StartedHub,
  lan: () => string | undefined = lanAddress,
): readonly string[] {
  const { settings, publicUrl } = started
  if (publicUrl === undefined) {
    const example = `http://${lan() ?? '<this-machine>'}:${started.publicPort}`
    return [
      `the hub listens on ${settings.bind} without --public-url, so it refuses to mint invites.`,
      `restart with --public-url ${example} (LAN), or your Tailscale / tunnel / domain URL.`,
    ]
  }
  if (isLoopbackHost(new URL(publicUrl).hostname)) {
    return [
      `invite links point at ${publicUrl}: only agents on this machine can join.`,
      'set --public-url to a LAN, Tailscale or public address to invite other machines.',
    ]
  }
  return []
}

export function listenerLines(started: StartedHub): readonly string[] {
  const { settings } = started
  const admin = `http://${hostForUrl(dialHost(settings.adminBind))}:${started.adminPort}/admin`
  return [
    `agent-peers hub ${started.version} (protocol ${PROTOCOL_VERSION})`,
    `  public listener  ${hostForUrl(settings.bind)}:${started.publicPort}  (bridges, invites, /app)`,
    `  admin listener   ${admin}  (sign in with ${adminTokenPath(settings.dataDir)})`,
    `  data dir         ${settings.dataDir}`,
    `  public url       ${started.publicUrl ?? 'not set'}`,
    `  registration     ${settings.registration}`,
    `  dashboard        ${started.dashboard ? 'embedded' : 'not built (placeholder pages)'}`,
  ]
}

export function bootstrapLines(started: StartedHub): readonly string[] {
  const { bootstrap } = started
  if (bootstrap === undefined) return ['mint an invite with: agent-peers invite [room]']
  return [
    '',
    `created room "default". Invite link: ${bootstrap.inviteUrl}`,
    ...(bootstrap.joinPrompt === undefined
      ? []
      : ["paste this join prompt into a teammate's agent:", '', bootstrap.joinPrompt]),
  ]
}
