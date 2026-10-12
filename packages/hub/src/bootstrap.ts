/**
 * First-start bootstrap (§8): the admin token (persisted to `<dataDir>/admin-token`, mode 0600),
 * the invite secret, and the `default` room with its invite on an invite-only hub.
 */
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { generateSecret } from './auth/tokens'
import { type HubConfig, isMemoryDataDir } from './config'
import type { Services } from './services/index'

export const ADMIN_TOKEN_FILE = 'admin-token'
export const INVITE_SECRET_FILE = 'invite-secret'
export const DEFAULT_ROOM = 'default'

const SECRET_MODE = 0o600
const DIR_MODE = 0o700

async function readSecret(path: string): Promise<string | undefined> {
  try {
    const text = (await readFile(path, 'utf8')).trim()
    return text === '' ? undefined : text
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

/** Writes a secret file with mode 0600 (chmod again in case it already existed). */
export async function writeSecret(path: string, value: string): Promise<void> {
  await writeFile(path, `${value}\n`, { mode: SECRET_MODE })
  await chmod(path, SECRET_MODE)
}

/** Creates the data dir 0700, and tightens one that already existed with a looser mode. */
export async function ensureDataDir(dataDir: string): Promise<void> {
  if (isMemoryDataDir(dataDir)) return
  await mkdir(dataDir, { recursive: true, mode: DIR_MODE })
  await chmod(dataDir, DIR_MODE)
}

/** The invite-code secret: configured, persisted in `dataDir`, or random for an in-memory hub. */
export async function resolveInviteSecret(config: HubConfig): Promise<string> {
  if (config.inviteSecret !== undefined) return config.inviteSecret
  if (isMemoryDataDir(config.dataDir)) return generateSecret()
  const path = join(config.dataDir, INVITE_SECRET_FILE)
  const existing = await readSecret(path)
  if (existing !== undefined) return existing
  const secret = generateSecret()
  await writeSecret(path, secret)
  return secret
}

/**
 * Returns the admin token. A persisted hub reuses `<dataDir>/admin-token` while it still matches the
 * stored hash, and otherwise mints a new one (first start, or a lost file).
 */
export async function bootstrapAdminToken(services: Services, config: HubConfig): Promise<string> {
  if (isMemoryDataDir(config.dataDir)) return services.auth.rotateAdmin()
  const path = join(config.dataDir, ADMIN_TOKEN_FILE)
  const existing = await readSecret(path)
  if (existing !== undefined && services.auth.verifyAdmin(existing)) return existing
  const token = services.auth.rotateAdmin()
  await writeSecret(path, token)
  return token
}

/** Creates the `default` room and its invite on the first start of an invite-only hub. */
export function bootstrapDefaultRoom(
  services: Services,
  config: HubConfig,
  firstStart: boolean,
): string | undefined {
  if (!firstStart || !config.bootstrapDefaultRoom || config.registration !== 'invite-only') return undefined
  const { repos } = services.deps
  if (repos.rooms.activeByName(DEFAULT_ROOM)) return undefined
  const room = services.deps.tx((fx) =>
    services.rooms.insertRoom(fx, { name: DEFAULT_ROOM, discoverable: false }, null),
  )
  const invite = repos.invites.active(room.id)
  if (!invite || services.deps.runtime.publicUrl === undefined) {
    config.logger.warn('created the default room; set --public-url to print its invite URL')
    return undefined
  }
  return services.invites.render(room, invite).invite_url
}
