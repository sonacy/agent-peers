/**
 * Runs `agent-peers hub` in-process (ports 0, temp HOME and AGENT_PEERS_HOME) with a fake signal
 * source, so tests can drive the admin commands against it and stop it like SIGINT would.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type HubCommandDeps, hubCommand } from '../../src/commands/hub'
import type { DashboardLoader } from '../../src/commands/hub-dashboard'
import type { RunningHub, SignalSource, StopSignal } from '../../src/commands/hub-run'
import { type AdminCommandDeps, inviteCommand } from '../../src/commands/invite'
import { roomsCommand } from '../../src/commands/rooms'
import { versionCommand } from '../../src/commands/version'
import type { CliIo } from '../../src/io'
import { type ExitCode, runRoot } from '../../src/root'
import { memoryIo } from './world'

/** The hub-side commands only (the full program also loads modules other workflows own). */
export interface HubProgramDeps {
  readonly hub?: HubCommandDeps
  readonly admin?: AdminCommandDeps
}

export function hubMain(argv: readonly string[], io: CliIo, deps: HubProgramDeps = {}): Promise<ExitCode> {
  return runRoot(argv, io, (scoped, setExit) => [
    hubCommand(scoped, setExit, deps.hub ?? {}),
    inviteCommand(scoped, setExit, deps.admin ?? {}),
    roomsCommand(scoped, setExit, deps.admin ?? {}),
    versionCommand(scoped, setExit),
  ])
}

export interface FakeSignals {
  readonly source: SignalSource
  fire(signal: StopSignal): void
}

export function fakeSignals(): FakeSignals {
  const handlers = new Map<StopSignal, () => void>()
  return {
    source: {
      once(signal, handler) {
        handlers.set(signal, handler)
        return () => handlers.delete(signal)
      },
    },
    fire: (signal) => handlers.get(signal)?.(),
  }
}

export interface CliResult {
  readonly code: ExitCode
  readonly out: string
  readonly err: string
}

export async function runCli(
  argv: readonly string[],
  env: Record<string, string>,
  deps: HubProgramDeps = {},
): Promise<CliResult> {
  const io = memoryIo(env)
  const code = await hubMain(argv, io, deps)
  return { code, out: io.out.join(''), err: io.err.join('') }
}

export interface HubCli {
  readonly dir: string
  /** AGENT_PEERS_HOME */
  readonly home: string
  readonly dataDir: string
  readonly env: Record<string, string>
  readonly running: RunningHub
  readonly out: () => string
  readonly err: () => string
  /** Fires SIGINT (or `signal`) and resolves with the hub command's exit code. */
  stop(signal?: StopSignal): Promise<ExitCode>
  cleanup(): Promise<void>
}

export interface HubCliOptions {
  readonly args?: readonly string[]
  readonly loadDashboard?: DashboardLoader
  readonly dir?: string
}

const noDashboard: DashboardLoader = async () => undefined

export async function startHubCli(options: HubCliOptions = {}): Promise<HubCli> {
  const dir = options.dir ?? (await mkdtemp(join(tmpdir(), 'aph-')))
  const home = join(dir, 'peers')
  const env = { HOME: dir, AGENT_PEERS_HOME: home }
  const io = memoryIo(env)
  const signals = fakeSignals()
  let resolveStarted: (running: RunningHub) => void = () => undefined
  const started = new Promise<RunningHub>((resolve) => {
    resolveStarted = resolve
  })
  const argv = ['hub', '--bind', '127.0.0.1', '--port', '0', '--admin-port', '0', ...(options.args ?? [])]
  const done = hubMain(argv, io, {
    hub: {
      run: {
        signals: signals.source,
        loadDashboard: options.loadDashboard ?? noDashboard,
        onStarted: resolveStarted,
        hubOptions: { sweepIntervalMs: 60_000 },
      },
    },
  })
  const running = await Promise.race([
    started,
    done.then((code) => {
      throw new Error(`hub exited with ${code}: ${io.err.join('')}`)
    }),
  ])
  return {
    dir,
    home,
    dataDir: join(home, 'hub'),
    env,
    running,
    out: () => io.out.join(''),
    err: () => io.err.join(''),
    async stop(signal = 'SIGINT') {
      signals.fire(signal)
      return done
    },
    async cleanup() {
      await running.stop()
      await rm(dir, { recursive: true, force: true })
    },
  }
}
