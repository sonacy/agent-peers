/**
 * `agent-peers hub rotate-admin-token` (PROTOCOL §8): through the running hub's admin API (which
 * also signs other browsers out), or directly in `hub.db` when no hub is running.
 */
import { existsSync } from 'node:fs'
import { createHub, databasePath, silentLogger, writeSecret } from '@agent-peers/hub'
import { isPeersError, PeersError } from '@agent-peers/protocol'
import { renderError } from '../errors'
import type { GlobalOptions } from '../globals'
import type { CliIo } from '../io'
import { type AdminClientDeps, createAdminClient, field, resolveAdminTarget } from './admin-client'
import { adminTokenPath, readHubState } from './hub-state'

export interface RotateResult {
  readonly path: string
  /** True when the running hub rotated it (and signed out other admin browsers). */
  readonly live: boolean
}

/** Rotates in the database without listening (no hub is running). */
export async function rotateOffline(dataDir: string): Promise<RotateResult> {
  if (!existsSync(databasePath(dataDir))) {
    throw new PeersError('invalid_params', `no hub data in ${dataDir}: start "agent-peers hub" first`)
  }
  const hub = createHub({ dataDir, logger: silentLogger, bootstrapDefaultRoom: false })
  try {
    const token = hub.services.auth.rotateAdmin()
    await writeSecret(adminTokenPath(dataDir), token)
  } finally {
    await hub.stop()
  }
  return { path: adminTokenPath(dataDir), live: false }
}

/** Rotates through the admin API; undefined when no hub answers (or it refused the old token). */
async function rotateLive(
  dataDir: string,
  deps: AdminClientDeps,
  adminUrl: string | undefined,
): Promise<RotateResult | undefined> {
  if (adminUrl === undefined && (await readHubState(dataDir)) === undefined) return undefined
  let response: unknown
  try {
    const client = createAdminClient(await resolveAdminTarget(dataDir, adminUrl), deps)
    response = await client.request('POST', '/v0/admin/rotate-admin-token')
  } catch (error) {
    if (isPeersError(error, 'not_connected') || isPeersError(error, 'unauthorized')) return undefined
    throw error
  }
  const token = field(response, 'admin_token')
  if (field(response, 'persisted') !== true && typeof token === 'string') {
    await writeSecret(adminTokenPath(dataDir), token)
  }
  return { path: adminTokenPath(dataDir), live: true }
}

export async function runRotateAdminToken(
  dataDir: string,
  io: CliIo,
  deps: AdminClientDeps & { readonly adminUrl?: string } = {},
  globals: GlobalOptions = {},
): Promise<number> {
  try {
    const result = (await rotateLive(dataDir, deps, deps.adminUrl)) ?? (await rotateOffline(dataDir))
    if (globals.json) {
      io.stdout(`${JSON.stringify(result)}\n`)
    } else {
      io.stdout(
        `${[
          `rotated the admin token: the new one is in ${result.path} (mode 0600).`,
          result.live
            ? 'browsers signed in to /admin were signed out.'
            : 'no hub was running; it uses the new token on its next start.',
        ].join('\n')}\n`,
      )
    }
    return 0
  } catch (error) {
    return renderError(io, error, globals)
  }
}
