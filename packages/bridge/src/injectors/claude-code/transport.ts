/**
 * How a hook process reaches its bridge: discovery by ancestor PID (ARCHITECTURE §5) and one
 * control-socket request per call. Injectable so tests can use fake process trees or fake bridges.
 */
import {
  type BridgeInfo,
  type CallOptions,
  type ControlOp,
  type ControlParamsInput,
  type ControlResult,
  callBridge,
  callControl,
  discoverBridges,
  isPeersError,
  type ProcessTree,
} from '@agent-peers/core'

export interface BridgeCall<Op extends ControlOp> {
  /** PID of the bridge that answered (one Claude Code process runs one bridge). */
  readonly bridgePid: number
  readonly result: ControlResult<Op>
}

export interface BridgeCaller {
  /** PID of the bridge this hook would talk to for `localKey`; undefined when none is running. */
  locate(localKey: string): Promise<number | undefined>
  call<Op extends ControlOp>(
    op: Op,
    params: ControlParamsInput<Op>,
    options?: CallOptions,
  ): Promise<BridgeCall<Op>>
}

export interface DiscoveryOptions {
  /** `<home>/run`. */
  readonly runDir: string
  /** The hook's own PID (default `process.pid`); discovery walks its ancestors. */
  readonly pid?: number
  readonly tree?: ProcessTree
  /**
   * How long to keep looking when no bridge answers yet. Claude Code starts hooks and the MCP server
   * at the same time, so a SessionStart hook can run before the bridge has published `run/<pid>.json`.
   */
  readonly discoverWaitMs?: number
  /** Injectable for tests. */
  readonly sleep?: (ms: number) => Promise<void>
}

/** Default wait for a bridge that is still starting (it runs `ps` before publishing its info file). */
export const DEFAULT_DISCOVER_WAIT_MS = 3000
const DISCOVER_POLL_MS = 100

/**
 * Discovers the bridge serving this hook's agent process once per hook process (each discovery
 * walk spawns `ps` per ancestor) and reuses it; a bridge that went away (`not_connected`) is
 * rediscovered, since bridges can restart.
 */
export function discoveryCaller(options: DiscoveryOptions): BridgeCaller {
  const target = (localKey: string | undefined) => ({
    runDir: options.runDir,
    ...(localKey === undefined ? {} : { localKey }),
    ...(options.pid === undefined ? {} : { pid: options.pid }),
    ...(options.tree === undefined ? {} : { tree: options.tree }),
  })
  let cached: BridgeInfo | undefined
  const waitMs = options.discoverWaitMs ?? 0
  const sleep = options.sleep ?? ((ms: number) => Bun.sleep(ms))
  const discover = async <Op extends ControlOp>(
    op: Op,
    params: ControlParamsInput<Op>,
    callOptions: CallOptions | undefined,
  ): Promise<BridgeCall<Op>> => {
    const localKey = (params as { local_key?: string }).local_key
    for (let waited = 0; ; waited += DISCOVER_POLL_MS) {
      try {
        const { bridge, result } = await callBridge(target(localKey), op, params, callOptions)
        cached = bridge
        return { bridgePid: bridge.pid, result }
      } catch (error) {
        // Only "no bridge yet / not reachable" is worth waiting for; anything else is a real answer.
        if (!isPeersError(error, 'not_connected') || waited >= waitMs) throw error
        await sleep(DISCOVER_POLL_MS)
      }
    }
  }
  return {
    // SessionStart locates before it calls, so locating must honour the startup wait too: Claude Code
    // starts the hook and the MCP server together, and the bridge is usually not published yet.
    async locate(localKey) {
      if (cached) return cached.pid
      for (let waited = 0; ; waited += DISCOVER_POLL_MS) {
        const [first] = await discoverBridges(target(localKey))
        if (first !== undefined || waited >= waitMs) {
          cached = first
          return first?.pid
        }
        await sleep(DISCOVER_POLL_MS)
      }
    },
    async call(op, params, callOptions) {
      const bridge = cached
      if (!bridge) return discover(op, params, callOptions)
      try {
        return { bridgePid: bridge.pid, result: await callControl(bridge.socket, op, params, callOptions) }
      } catch (error) {
        if (!isPeersError(error, 'not_connected')) throw error
        cached = undefined
        return discover(op, params, callOptions)
      }
    },
  }
}
