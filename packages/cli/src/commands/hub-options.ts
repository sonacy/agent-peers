/**
 * `agent-peers hub` flags (ARCHITECTURE §7, PROTOCOL §9): parsed and validated once, turned into the
 * hub config, and turned back into argv for the service unit.
 */
import { isAbsolute, join, resolve } from 'node:path'
import {
  DEFAULT_ADMIN_BIND,
  DEFAULT_ADMIN_PORT,
  DEFAULT_PUBLIC_PORT,
  PeersError,
} from '@agent-peers/protocol'
import { type Command, InvalidArgumentError, Option } from 'commander'

export const REGISTRATIONS = ['invite-only', 'open'] as const
export type RegistrationMode = (typeof REGISTRATIONS)[number]

export const DEFAULT_PUBLIC_BIND = '0.0.0.0'
/** The data dir below the agent-peers home: `hub.db`, `admin-token`, `invite-secret`, `hub.json`. */
export const HUB_DIR = 'hub'

/** The raw flags as commander hands them over. */
export interface HubFlags {
  readonly publicUrl?: string
  readonly port?: number
  readonly bind?: string
  readonly adminPort?: number
  readonly adminBind?: string
  readonly dataDir?: string
  readonly registration?: RegistrationMode
  readonly minAdapter?: string
}

export interface HubSettings {
  readonly publicUrl: string | undefined
  readonly port: number
  readonly bind: string
  readonly adminPort: number
  readonly adminBind: string
  readonly dataDir: string
  readonly registration: RegistrationMode
  readonly minAdapter: string | undefined
}

const SEMVER = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/

export function parsePort(value: string): number {
  const port = Number(value)
  if (!/^\d+$/.test(value) || !Number.isInteger(port) || port > 65535) {
    throw new InvalidArgumentError('expected a port number (0-65535)')
  }
  return port
}

function parseSemver(value: string): string {
  if (!SEMVER.test(value)) throw new InvalidArgumentError('expected a version like 0.1.0')
  return value
}

/** `--public-url`: an absolute http(s) URL; the trailing slash is dropped. */
export function normalizePublicUrl(value: string): string {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new PeersError('invalid_params', `--public-url ${value} is not a URL`)
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new PeersError('invalid_params', '--public-url must start with http:// or https://')
  }
  if (url.search !== '' || url.hash !== '' || url.username !== '' || url.password !== '') {
    throw new PeersError('invalid_params', '--public-url must not carry credentials, a query or a fragment')
  }
  return url.toString().replace(/\/+$/, '')
}

export function defaultDataDir(home: string): string {
  return join(home, HUB_DIR)
}

export function resolveDataDir(home: string, dataDir: string | undefined): string {
  if (dataDir === undefined) return defaultDataDir(home)
  return isAbsolute(dataDir) ? dataDir : resolve(dataDir)
}

export function resolveHubSettings(flags: HubFlags, home: string): HubSettings {
  return {
    publicUrl: flags.publicUrl === undefined ? undefined : normalizePublicUrl(flags.publicUrl),
    port: flags.port ?? DEFAULT_PUBLIC_PORT,
    bind: flags.bind ?? DEFAULT_PUBLIC_BIND,
    adminPort: flags.adminPort ?? DEFAULT_ADMIN_PORT,
    adminBind: flags.adminBind ?? DEFAULT_ADMIN_BIND,
    dataDir: resolveDataDir(home, flags.dataDir),
    registration: flags.registration ?? 'invite-only',
    minAdapter: flags.minAdapter,
  }
}

/** Only the data-dir flag: what the admin subcommands need to find the hub. */
export function addDataDirOption(command: Command): Command {
  return command.option('--data-dir <dir>', 'hub data directory (default: <home>/hub)')
}

/** Adds every hub flag to `command`. */
export function addHubOptions(command: Command): Command {
  return addDataDirOption(
    command
      .option('--public-url <url>', 'the URL members reach this hub at (invite links are built from it)')
      .option('--port <port>', `public listener port (default ${DEFAULT_PUBLIC_PORT})`, parsePort)
      .option('--bind <host>', `public listener address (default ${DEFAULT_PUBLIC_BIND})`)
      .option('--admin-port <port>', `admin listener port (default ${DEFAULT_ADMIN_PORT})`, parsePort)
      .option('--admin-bind <host>', `admin listener address (default ${DEFAULT_ADMIN_BIND})`),
  )
    .addOption(
      new Option('--registration <mode>', 'who may register (default invite-only)').choices(REGISTRATIONS),
    )
    .option('--min-adapter <version>', 'mark sessions of older adapters as outdated', parseSemver)
}

/** The flags that reproduce `settings` (the data dir is always explicit, so the unit is stable). */
export function hubArgs(settings: HubSettings): readonly string[] {
  return [
    ...(settings.publicUrl === undefined ? [] : ['--public-url', settings.publicUrl]),
    ...(settings.port === DEFAULT_PUBLIC_PORT ? [] : ['--port', String(settings.port)]),
    ...(settings.bind === DEFAULT_PUBLIC_BIND ? [] : ['--bind', settings.bind]),
    ...(settings.adminPort === DEFAULT_ADMIN_PORT ? [] : ['--admin-port', String(settings.adminPort)]),
    ...(settings.adminBind === DEFAULT_ADMIN_BIND ? [] : ['--admin-bind', settings.adminBind]),
    '--data-dir',
    settings.dataDir,
    ...(settings.registration === 'invite-only' ? [] : ['--registration', settings.registration]),
    ...(settings.minAdapter === undefined ? [] : ['--min-adapter', settings.minAdapter]),
  ]
}
