/** Entry used by `agent-peers mcp --surface <s> [--selftest]` (ARCHITECTURE §2 cli `mcp`). */
import type { EnvLike } from '@agent-peers/core'
import { PeersError } from '@agent-peers/protocol'
import { type Bridge, type BridgeOptions, createBridge } from './bridge'
import { BRIDGE_SURFACES, type BridgeSurface, isBridgeSurface } from './surface/surfaces'

export interface McpArgs {
  readonly surface: BridgeSurface
  /** ONBOARDING §3 step 3: start, report and exit. */
  readonly selftest: boolean
}

/** Parses the arguments after `mcp`: `--surface <s>` (or `--surface=<s>`) and `--selftest`. */
export function parseMcpArgs(argv: readonly string[]): McpArgs {
  let surface: string | undefined
  let selftest = false
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] as string
    if (arg === '--selftest') selftest = true
    else if (arg === '--surface') surface = argv[++i]
    else if (arg.startsWith('--surface=')) surface = arg.slice('--surface='.length)
    else throw new PeersError('invalid_params', `unknown argument ${arg}`)
  }
  if (!isBridgeSurface(surface))
    throw new PeersError('invalid_params', `--surface must be one of ${BRIDGE_SURFACES.join(', ')}`)
  return { surface, selftest }
}

export interface RunMcpOptions extends Omit<BridgeOptions, 'surface'> {
  readonly argv: readonly string[]
  readonly env?: EnvLike
  /** Where `--selftest` reports (default stderr). */
  readonly report?: (line: string) => void
  /** Exit the process once the bridge shut down, and shut down on SIGINT/SIGTERM (default true). */
  readonly ownProcess?: boolean
  /** The process to own (tests pass a fake). */
  readonly processLike?: ProcessLike
}

export interface ProcessLike {
  once(signal: 'SIGINT' | 'SIGTERM', listener: () => void): unknown
  exit(code: number): void
}

/** Ties the process to the bridge: signals shut it down, and its shutdown ends the process. */
export function bindProcess(bridge: Bridge, proc: ProcessLike): void {
  const stop = () => void bridge.close()
  proc.once('SIGINT', stop)
  proc.once('SIGTERM', stop)
  void bridge.whenClosed().then(() => proc.exit(0))
}

/**
 * Starts the bridge over stdio and returns it. With `--selftest` it only proves the bridge can be
 * built and returns undefined.
 */
export async function runMcp(options: RunMcpOptions): Promise<Bridge | undefined> {
  const { argv, report, ownProcess = true, processLike = process, ...rest } = options
  const args = parseMcpArgs(argv)
  const bridge = createBridge({ ...rest, surface: args.surface })
  if (args.selftest) {
    ;(report ?? ((line: string) => process.stderr.write(`${line}\n`)))(
      `agent-peers mcp selftest ok (${args.surface})`,
    )
    await bridge.close()
    return undefined
  }
  if (ownProcess) bindProcess(bridge, processLike)
  await bridge.start()
  return bridge
}
