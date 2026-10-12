/**
 * `<data-dir>/hub.json`: where a running hub listens, so `invite`, `rooms` and
 * `hub rotate-admin-token` find its admin listener (also on a port picked at random). Written 0600
 * on start, removed on a clean stop.
 */
import { readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { writePrivateFileAtomic } from '@agent-peers/core'
import { ADMIN_TOKEN_FILE } from '@agent-peers/hub'

export const STATE_FILE = 'hub.json'

export interface HubState {
  readonly pid: number
  readonly version: string
  readonly public_port: number
  readonly admin_port: number
  readonly admin_bind: string
  readonly public_url: string | null
  readonly started_at: number
}

export function statePath(dataDir: string): string {
  return join(dataDir, STATE_FILE)
}

export function adminTokenPath(dataDir: string): string {
  return join(dataDir, ADMIN_TOKEN_FILE)
}

export async function writeHubState(dataDir: string, state: HubState): Promise<void> {
  await writePrivateFileAtomic(statePath(dataDir), `${JSON.stringify(state, null, 2)}\n`)
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const isPort = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value > 0 && value <= 65535

function parseState(value: unknown): HubState | undefined {
  if (!isRecord(value)) return undefined
  const { pid, version, public_port, admin_port, admin_bind, public_url, started_at } = value
  if (typeof pid !== 'number' || !isPort(public_port) || !isPort(admin_port)) return undefined
  if (typeof admin_bind !== 'string' || typeof version !== 'string') return undefined
  return {
    pid,
    version,
    public_port,
    admin_port,
    admin_bind,
    public_url: typeof public_url === 'string' ? public_url : null,
    started_at: typeof started_at === 'number' ? started_at : 0,
  }
}

/** The recorded state, or undefined when there is none or it is unreadable. */
export async function readHubState(dataDir: string): Promise<HubState | undefined> {
  let text: string
  try {
    text = await readFile(statePath(dataDir), 'utf8')
  } catch {
    return undefined
  }
  try {
    return parseState(JSON.parse(text))
  } catch {
    return undefined
  }
}

/** Removes the state file if it still belongs to `pid` (a newer hub may have replaced it). */
export async function removeHubState(dataDir: string, pid: number): Promise<void> {
  const current = await readHubState(dataDir)
  if (current !== undefined && current.pid !== pid) return
  await rm(statePath(dataDir), { force: true })
}

/** The admin token written by the hub, or undefined when the file is missing or empty. */
export async function readAdminToken(dataDir: string): Promise<string | undefined> {
  try {
    const token = (await readFile(adminTokenPath(dataDir), 'utf8')).trim()
    return token === '' ? undefined : token
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}
