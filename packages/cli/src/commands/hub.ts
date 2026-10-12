/**
 * `agent-peers hub [flags]` runs the hub (ARCHITECTURE §7, PROTOCOL §8–§9); its subcommands manage
 * it: `hub service install|uninstall|status` and `hub rotate-admin-token`. The hub flags belong to
 * `hub` itself, so `hub service install --public-url …` reads them from there.
 */
import { type Command, Command as CommanderCommand } from 'commander'
import { renderError } from '../errors'
import { globalsOf, peersHomeOf } from '../globals'
import type { CliIo } from '../io'
import type { AdminClientDeps } from './admin-client'
import { addHubOptions, type HubFlags, resolveDataDir, resolveHubSettings } from './hub-options'
import { runRotateAdminToken } from './hub-rotate'
import { type HubRunDeps, runHub } from './hub-run'
import { runService, type ServiceAction, type ServiceDeps } from './hub-service'

export interface HubCommandDeps {
  readonly run?: HubRunDeps
  readonly service?: ServiceDeps
  readonly admin?: AdminClientDeps
}

type SetExit = (code: number) => void

/** The hub flags as seen from `command` (itself or a subcommand of `hub`). */
export function hubFlagsOf(command: Command): HubFlags {
  return command.optsWithGlobals<HubFlags>()
}

export function hubDataDir(io: CliIo, command: Command): string {
  return resolveDataDir(peersHomeOf(io), hubFlagsOf(command).dataDir)
}

function serviceCommand(io: CliIo, setExit: SetExit, deps: ServiceDeps): Command {
  const service = new CommanderCommand('service').description(
    'run the hub as a per-user service (launchd on macOS, systemd --user on Linux)',
  )
  const actions: ReadonlyArray<readonly [ServiceAction, string]> = [
    ['install', 'write the service unit with the hub flags given to "hub" and start it'],
    ['uninstall', 'stop the service and remove its unit'],
    ['status', 'show whether the service is installed and running'],
  ]
  for (const [action, description] of actions) {
    service.addCommand(
      new CommanderCommand(action)
        .description(description)
        .action(async (_options: unknown, self: Command) => {
          setExit(await runService(action, hubFlagsOf(self), io, deps, globalsOf(self)))
        }),
    )
  }
  return service
}

function rotateCommand(io: CliIo, setExit: SetExit, deps: AdminClientDeps): Command {
  return new CommanderCommand('rotate-admin-token')
    .description('replace the admin token (written to <data-dir>/admin-token)')
    .option('--admin-url <url>', 'admin listener of the running hub (default: from <data-dir>/hub.json)')
    .action(async (options: { readonly adminUrl?: string }, self: Command) => {
      const rotateDeps = {
        ...deps,
        ...(options.adminUrl === undefined ? {} : { adminUrl: options.adminUrl }),
      }
      setExit(await runRotateAdminToken(hubDataDir(io, self), io, rotateDeps, globalsOf(self)))
    })
}

export function hubCommand(io: CliIo, setExit: SetExit, deps: HubCommandDeps = {}): Command {
  const hub = addHubOptions(
    new CommanderCommand('hub').description('run the agent-peers hub (WebSocket, HTTP, dashboard)'),
  )
  hub.action(async (_options: HubFlags, self: Command) => {
    const globals = globalsOf(self)
    try {
      const settings = resolveHubSettings(hubFlagsOf(self), peersHomeOf(io))
      setExit(await runHub(settings, io, deps.run, globals))
    } catch (error) {
      setExit(renderError(io, error, globals))
    }
  })
  hub.addCommand(serviceCommand(io, setExit, deps.service ?? {}))
  hub.addCommand(rotateCommand(io, setExit, deps.admin ?? {}))
  return hub
}
