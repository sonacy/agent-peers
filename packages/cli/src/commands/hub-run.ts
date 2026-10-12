/**
 * Runs the hub in this process: createHub with the HTTP layer (and the embedded dashboard when
 * built), the startup report, `<data-dir>/hub.json`, and a graceful stop on SIGINT / SIGTERM.
 */
import {
  type AssetMap,
  type CreateHubOptions,
  createHub,
  DEFAULT_ROOM,
  type Hub,
  type Logger,
  type StartInfo,
} from '@agent-peers/hub'
import type { GlobalOptions } from '../globals'
import type { CliIo } from '../io'
import { CLI_VERSION } from '../version'
import { type DashboardLoader, loadDashboardAssets } from './hub-dashboard'
import type { HubSettings } from './hub-options'
import { bootstrapLines, hubWarnings, listenerLines, type StartedHub } from './hub-output'
import { removeHubState, writeHubState } from './hub-state'

export type StopSignal = 'SIGINT' | 'SIGTERM'

/** Subscribes to a stop signal once; returns the unsubscribe. */
export interface SignalSource {
  once(signal: StopSignal, handler: () => void): () => void
}

export const processSignals: SignalSource = {
  once(signal, handler) {
    process.once(signal, handler)
    return () => {
      process.off(signal, handler)
    }
  },
}

export interface HubRunDeps {
  readonly version?: string
  readonly loadDashboard?: DashboardLoader
  readonly signals?: SignalSource
  readonly pid?: number
  /** Extra createHub options (tests: short timers). */
  readonly hubOptions?: Partial<CreateHubOptions>
  /** Called once the hub listens (tests drive it from here). */
  readonly onStarted?: (running: RunningHub) => void
}

export interface RunningHub {
  readonly hub: Hub
  readonly started: StartedHub
  stop(): Promise<void>
}

export function cliLogger(io: CliIo, verbose: boolean): Logger {
  return {
    info: (message) => {
      if (verbose) io.stderr(`[hub] ${message}\n`)
    },
    warn: (message) => io.stderr(`warning: ${message}\n`),
    error: (message, error) =>
      io.stderr(`error: ${message}${error === undefined ? '' : ` ${String(error)}`}\n`),
  }
}

function bootstrapPrompt(hub: Hub): string | undefined {
  const room = hub.services.deps.repos.rooms.activeByName(DEFAULT_ROOM)
  return room === undefined ? undefined : (hub.services.invites.promptFor(room.id) ?? undefined)
}

/** The createHub options for `settings` (the dashboard serves both `/app` and `/admin`). */
export function hubOptionsFor(
  settings: HubSettings,
  version: string,
  logger: Logger,
  assets: AssetMap | undefined,
): CreateHubOptions {
  return {
    dataDir: settings.dataDir,
    publicBind: settings.bind,
    publicPort: settings.port,
    adminBind: settings.adminBind,
    adminPort: settings.adminPort,
    registration: settings.registration,
    version,
    logger,
    ...(settings.publicUrl === undefined ? {} : { publicUrl: settings.publicUrl }),
    ...(settings.minAdapter === undefined ? {} : { minAdapter: settings.minAdapter }),
    ...(assets === undefined ? {} : { http: { dashboard: { assets }, admin: { assets } } }),
  }
}

function startedFrom(
  hub: Hub,
  info: StartInfo,
  settings: HubSettings,
  version: string,
  dashboard: boolean,
): StartedHub {
  return {
    version,
    settings,
    publicPort: info.publicPort,
    adminPort: info.adminPort,
    publicUrl: info.publicUrl,
    dashboard,
    ...(info.bootstrapInviteUrl === undefined
      ? {}
      : { bootstrap: { inviteUrl: info.bootstrapInviteUrl, joinPrompt: bootstrapPrompt(hub) } }),
  }
}

/** Starts the hub and records where it listens; anything that fails after listening stops it again. */
export async function startHub(
  settings: HubSettings,
  io: CliIo,
  deps: HubRunDeps = {},
  globals: GlobalOptions = {},
): Promise<RunningHub> {
  const logger = cliLogger(io, globals.verbose === true)
  const version = deps.version ?? CLI_VERSION
  const assets = await (deps.loadDashboard ?? loadDashboardAssets)(logger.warn)
  const hub = createHub({ ...hubOptionsFor(settings, version, logger, assets), ...deps.hubOptions })
  const pid = deps.pid ?? process.pid
  try {
    const info = await hub.start()
    await writeHubState(settings.dataDir, {
      pid,
      version,
      public_port: info.publicPort,
      admin_port: info.adminPort,
      admin_bind: settings.adminBind,
      public_url: info.publicUrl ?? null,
      started_at: Date.now(),
    })
    let stopping: Promise<void> | undefined
    const stop = () => {
      stopping ??= hub.stop().then(() => removeHubState(settings.dataDir, pid))
      return stopping
    }
    return { hub, started: startedFrom(hub, info, settings, version, assets !== undefined), stop }
  } catch (error) {
    await hub.stop()
    throw error
  }
}

function report(io: CliIo, started: StartedHub, json: boolean): void {
  const warnings = hubWarnings(started)
  if (json) {
    const { settings, ...rest } = started
    io.stdout(`${JSON.stringify({ ...rest, data_dir: settings.dataDir, warnings })}\n`)
    return
  }
  io.stdout(`${listenerLines(started).join('\n')}\n`)
  for (const line of warnings) io.stderr(`warning: ${line}\n`)
  io.stdout(`${bootstrapLines(started).join('\n')}\n`)
}

/** Resolves with the first stop signal. */
export function waitForStop(signals: SignalSource): Promise<StopSignal> {
  return new Promise((resolve) => {
    const offs = (['SIGINT', 'SIGTERM'] as const).map((signal) =>
      signals.once(signal, () => {
        for (const off of offs) off()
        resolve(signal)
      }),
    )
  })
}

/** `agent-peers hub`: runs until SIGINT / SIGTERM, then stops cleanly. */
export async function runHub(
  settings: HubSettings,
  io: CliIo,
  deps: HubRunDeps = {},
  globals: GlobalOptions = {},
): Promise<number> {
  const running = await startHub(settings, io, deps, globals)
  report(io, running.started, globals.json === true)
  const stopped = waitForStop(deps.signals ?? processSignals)
  deps.onStarted?.(running)
  const signal = await stopped
  if (globals.json !== true) io.stderr(`${signal}: stopping the hub\n`)
  await running.stop()
  return 0
}
