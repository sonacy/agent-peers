/** Hub configuration: defaults from PROTOCOL v0.3 (§1, §5, §8, §9), resolved once at createHub. */
import {
  DEFAULT_ADMIN_BIND,
  DEFAULT_ADMIN_PORT,
  DEFAULT_GRACE_MS,
  DEFAULT_HEARTBEAT_MS,
  DEFAULT_IDLE_CLOSE_MS,
  DEFAULT_PUBLIC_PORT,
  isLoopbackHost,
  MESSAGES_PER_MINUTE_PER_MEMBER,
  PeersError,
} from '@agent-peers/protocol'
import { type Clock, systemClock } from './clock'

export type Registration = 'invite-only' | 'open'

export interface Logger {
  info(message: string): void
  warn(message: string): void
  error(message: string, error?: unknown): void
}

export const MEMORY = ':memory:'

export interface HubConfigInput {
  /** A directory for `hub.db` and `admin-token`, or `':memory:'` (default) for an ephemeral hub. */
  readonly dataDir?: string
  readonly publicBind?: string
  readonly publicPort?: number
  readonly adminBind?: string
  readonly adminPort?: number
  /** `--public-url`; invite URLs are built from it (§9). */
  readonly publicUrl?: string
  readonly registration?: Registration
  readonly heartbeatMs?: number
  readonly graceMs?: number
  /** Bridges older than this are accepted but their sessions are `outdated` (§4). */
  readonly minAdapter?: string
  /** The hub's own version, pinned in join prompts (semver). */
  readonly version?: string
  /** Lets members create rooms (§6.4 `room.create`). Always true when `registration` is `open`. */
  readonly allowRoomCreation?: boolean
  /** Hub-side backstop for sessions that never close (§5.1). 0 disables it. */
  readonly idleCloseMs?: number
  /** How often the TTL / expiry / retention sweeper runs. */
  readonly sweepIntervalMs?: number
  readonly messagesPerMinute?: number
  /** Create the `default` room and its invite on first start (§8). */
  readonly bootstrapDefaultRoom?: boolean
  /** Secret that derives invite codes; generated (and persisted in `dataDir`) when absent. */
  readonly inviteSecret?: string
  readonly clock?: Clock
  readonly logger?: Logger
}

export interface HubConfig {
  readonly dataDir: string
  readonly publicBind: string
  readonly publicPort: number
  readonly adminBind: string
  readonly adminPort: number
  readonly publicUrl: string | undefined
  readonly registration: Registration
  readonly heartbeatMs: number
  readonly graceMs: number
  readonly minAdapter: string | undefined
  readonly version: string
  readonly allowRoomCreation: boolean
  readonly idleCloseMs: number
  readonly sweepIntervalMs: number
  readonly messagesPerMinute: number
  readonly bootstrapDefaultRoom: boolean
  readonly inviteSecret: string | undefined
  readonly clock: Clock
  readonly logger: Logger
}

const SEMVER = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/

export const silentLogger: Logger = Object.freeze({
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
})

export const consoleLogger: Logger = Object.freeze({
  info: (message: string) => console.info(`[hub] ${message}`),
  warn: (message: string) => console.warn(`[hub] ${message}`),
  error: (message: string, error?: unknown) => console.error(`[hub] ${message}`, error ?? ''),
})

function positive(name: string, value: number, allowZero = false): number {
  const ok = Number.isInteger(value) && (allowZero ? value >= 0 : value > 0)
  if (!ok)
    throw new PeersError(
      'invalid_params',
      `config ${name} must be a ${allowZero ? 'non-negative' : 'positive'} integer`,
    )
  return value
}

function port(name: string, value: number): number {
  if (!Number.isInteger(value) || value < 0 || value > 65535) {
    throw new PeersError('invalid_params', `config ${name} must be a port number`)
  }
  return value
}

export function resolveConfig(input: HubConfigInput = {}): HubConfig {
  const registration = input.registration ?? 'invite-only'
  const version = input.version ?? '0.1.0'
  if (!SEMVER.test(version)) throw new PeersError('invalid_params', 'config version must be semver')
  return Object.freeze({
    dataDir: input.dataDir ?? MEMORY,
    publicBind: input.publicBind ?? '0.0.0.0',
    publicPort: port('publicPort', input.publicPort ?? DEFAULT_PUBLIC_PORT),
    adminBind: input.adminBind ?? DEFAULT_ADMIN_BIND,
    adminPort: port('adminPort', input.adminPort ?? DEFAULT_ADMIN_PORT),
    publicUrl: input.publicUrl,
    registration,
    heartbeatMs: positive('heartbeatMs', input.heartbeatMs ?? DEFAULT_HEARTBEAT_MS),
    graceMs: positive('graceMs', input.graceMs ?? DEFAULT_GRACE_MS, true),
    minAdapter: input.minAdapter,
    version,
    allowRoomCreation: registration === 'open' || (input.allowRoomCreation ?? true),
    idleCloseMs: positive('idleCloseMs', input.idleCloseMs ?? DEFAULT_IDLE_CLOSE_MS, true),
    sweepIntervalMs: positive('sweepIntervalMs', input.sweepIntervalMs ?? 60_000),
    messagesPerMinute: positive(
      'messagesPerMinute',
      input.messagesPerMinute ?? MESSAGES_PER_MINUTE_PER_MEMBER,
    ),
    bootstrapDefaultRoom: input.bootstrapDefaultRoom ?? true,
    inviteSecret: input.inviteSecret,
    clock: input.clock ?? systemClock,
    logger: input.logger ?? consoleLogger,
  })
}

/** A bind address reachable only from this machine (unlike the wildcards 0.0.0.0 and ::). */
export function isLoopbackBind(host: string): boolean {
  return host !== '0.0.0.0' && host !== '::' && isLoopbackHost(host)
}

export function isMemoryDataDir(dataDir: string): boolean {
  return dataDir === MEMORY
}

/**
 * The base for invite and login URLs (§9): `publicUrl` when set, else the loopback listener.
 * Undefined when the hub listens on a non-loopback address without `--public-url`.
 */
export function resolvePublicUrl(config: HubConfig, boundPort: number): string | undefined {
  if (config.publicUrl !== undefined) return config.publicUrl.replace(/\/+$/, '')
  if (!isLoopbackBind(config.publicBind)) return undefined
  const host = config.publicBind.includes(':') ? `[${config.publicBind}]` : config.publicBind
  return `http://${host}:${boundPort}`
}
