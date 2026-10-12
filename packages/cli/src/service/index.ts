/**
 * `agent-peers hub service install|uninstall|status`: writes the per-user unit that runs the
 * installed binary as `agent-peers hub <flags>`, and drives launchctl / systemctl through a runner.
 */
import { lstat, mkdir, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { EnvLike } from '@agent-peers/core'
import { PeersError } from '@agent-peers/protocol'
import { binaryPaths, installBinary, sourceBinary } from '../assets/binary'
import { launchd } from './launchd'
import { systemd } from './systemd'
import type { ServiceContext, ServiceManager, ServiceSpec, ServiceStatus } from './types'

export { LAUNCHD_LABEL, launchd, parseLaunchdPrint, renderPlist } from './launchd'
export { quoteSystemd, renderUnit, SYSTEMD_UNIT, systemd } from './systemd'
export type { ServiceContext, ServiceManager, ServiceRunner, ServiceSpec, ServiceStatus } from './types'

const UNIT_MODE = 0o644

export function managerFor(platform: NodeJS.Platform): ServiceManager {
  if (platform === 'darwin') return launchd
  if (platform === 'linux') return systemd
  throw new PeersError(
    'invalid_params',
    `hub service is supported on macOS (launchd) and Linux (systemd), not ${platform}`,
  )
}

async function exists(path: string): Promise<boolean> {
  return (await lstat(path).catch(() => undefined)) !== undefined
}

/**
 * The binary the unit runs: `<home>/bin/current` (it follows upgrades made by `agent-peers add`).
 * When nothing is installed yet, the running compiled binary (or $AGENT_PEERS_BINARY) is installed
 * there first.
 */
export async function resolveServiceBinary(
  home: string,
  env: EnvLike,
  version: string,
  compiled?: boolean,
): Promise<{ readonly path: string; readonly installed: boolean }> {
  const paths = binaryPaths(home, version)
  if (await exists(paths.current)) return { path: paths.current, installed: false }
  const source = sourceBinary(env, compiled)
  if (source === undefined) {
    throw new PeersError(
      'invalid_params',
      `no installed agent-peers binary at ${paths.current}: run "agent-peers add" first (or set AGENT_PEERS_BINARY)`,
    )
  }
  const installed = await installBinary(source, home, version)
  return { path: installed.current, installed: true }
}

export interface InstallResult {
  readonly unitPath: string
  readonly lines: readonly string[]
}

export async function installService(
  manager: ServiceManager,
  ctx: ServiceContext,
  spec: ServiceSpec,
): Promise<InstallResult> {
  const unitPath = manager.unitPath(ctx)
  await mkdir(dirname(unitPath), { recursive: true })
  await mkdir(dirname(spec.logPath), { recursive: true, mode: 0o700 })
  await writeFile(unitPath, manager.render(spec), { mode: UNIT_MODE })
  const activated = await manager.activate(ctx)
  return { unitPath, lines: [`wrote ${unitPath}`, ...activated, ...manager.hints(ctx, spec)] }
}

export async function uninstallService(manager: ServiceManager, ctx: ServiceContext): Promise<InstallResult> {
  const unitPath = manager.unitPath(ctx)
  if (!(await exists(unitPath))) {
    return { unitPath, lines: [`no hub service installed (${unitPath} does not exist)`] }
  }
  const lines = await manager.deactivate(ctx)
  await rm(unitPath, { force: true })
  await manager.afterRemove?.(ctx)
  return { unitPath, lines: [...lines, `removed ${unitPath}`] }
}

export async function serviceStatus(manager: ServiceManager, ctx: ServiceContext): Promise<ServiceStatus> {
  return manager.status(ctx, await exists(manager.unitPath(ctx)))
}

export function statusLines(status: ServiceStatus): readonly string[] {
  if (!status.installed) return [`hub service: not installed (${status.unitPath})`]
  const state = status.running ? 'running' : status.loaded ? 'loaded, not running' : 'installed, not loaded'
  return [
    `hub service: ${state}${status.pid === undefined ? '' : ` (pid ${status.pid})`}`,
    `  ${status.manager} unit ${status.unitPath}`,
  ]
}
