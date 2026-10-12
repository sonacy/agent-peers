/** `agent-peers hub service install|uninstall|status`: the hub as a launchd / systemd user service. */
import { join } from 'node:path'
import { HOME_ENV } from '@agent-peers/core'
import { runProcess } from '../agents/sys'
import { renderError } from '../errors'
import { type GlobalOptions, peersHomeOf, userHomeOf } from '../globals'
import type { CliIo } from '../io'
import {
  installService,
  managerFor,
  resolveServiceBinary,
  type ServiceContext,
  type ServiceRunner,
  type ServiceSpec,
  serviceStatus,
  statusLines,
  uninstallService,
} from '../service/index'
import { CLI_VERSION } from '../version'
import { type HubFlags, hubArgs, resolveHubSettings } from './hub-options'
import { dialHost, hubWarnings, isLoopbackBindHost } from './hub-output'

export const SERVICE_LOG = 'hub.log'

export interface ServiceDeps {
  readonly platform?: NodeJS.Platform
  readonly uid?: number
  readonly run?: ServiceRunner
  readonly userHome?: string
  readonly version?: string
  /** Whether this process is the compiled binary (decides what gets installed when nothing is). */
  readonly compiled?: boolean
}

export type ServiceAction = 'install' | 'uninstall' | 'status'

export function serviceContext(io: CliIo, deps: ServiceDeps): ServiceContext {
  return {
    userHome: deps.userHome ?? userHomeOf(io),
    env: io.env,
    uid: deps.uid ?? process.getuid?.() ?? 0,
    run: deps.run ?? ((argv) => runProcess(argv, io.env)),
  }
}

/** Warnings for a service that would come up unable to mint invites, as `agent-peers hub` prints. */
function settingsWarnings(settings: ReturnType<typeof resolveHubSettings>): readonly string[] {
  const loopback = isLoopbackBindHost(settings.bind)
  const publicUrl =
    settings.publicUrl ?? (loopback ? `http://${dialHost(settings.bind)}:${settings.port}` : undefined)
  return hubWarnings({
    version: '',
    settings,
    publicPort: settings.port,
    adminPort: settings.adminPort,
    publicUrl,
    dashboard: false,
  })
}

async function install(io: CliIo, flags: HubFlags, deps: ServiceDeps, ctx: ServiceContext) {
  const manager = managerFor(deps.platform ?? process.platform)
  const home = peersHomeOf(io, ctx.userHome)
  const settings = resolveHubSettings(flags, home)
  const binary = await resolveServiceBinary(home, io.env, deps.version ?? CLI_VERSION, deps.compiled)
  const spec: ServiceSpec = {
    binary: binary.path,
    args: ['hub', ...hubArgs(settings)],
    env: { [HOME_ENV]: home },
    logPath: join(settings.dataDir, SERVICE_LOG),
    workingDir: settings.dataDir,
  }
  const result = await installService(manager, ctx, spec)
  const lines = [...(binary.installed ? [`installed ${binary.path}`] : []), ...result.lines]
  return { lines, warnings: settingsWarnings(settings), json: { unit: result.unitPath, spec } }
}

export async function runService(
  action: ServiceAction,
  flags: HubFlags,
  io: CliIo,
  deps: ServiceDeps = {},
  globals: GlobalOptions = {},
): Promise<number> {
  try {
    const ctx = serviceContext(io, deps)
    const manager = managerFor(deps.platform ?? process.platform)
    if (action === 'status') {
      const status = await serviceStatus(manager, ctx)
      io.stdout(globals.json ? `${JSON.stringify(status)}\n` : `${statusLines(status).join('\n')}\n`)
      return status.installed && status.running ? 0 : 1
    }
    if (action === 'uninstall') {
      const result = await uninstallService(manager, ctx)
      io.stdout(
        globals.json ? `${JSON.stringify({ unit: result.unitPath })}\n` : `${result.lines.join('\n')}\n`,
      )
      return 0
    }
    const result = await install(io, flags, deps, ctx)
    io.stdout(globals.json ? `${JSON.stringify(result.json)}\n` : `${result.lines.join('\n')}\n`)
    if (!globals.json) for (const line of result.warnings) io.stderr(`warning: ${line}\n`)
    return 0
  } catch (error) {
    return renderError(io, error, globals)
  }
}
