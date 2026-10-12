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
}

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
  const discover = async <Op extends ControlOp>(
    op: Op,
    params: ControlParamsInput<Op>,
    callOptions: CallOptions | undefined,
  ): Promise<BridgeCall<Op>> => {
    const localKey = (params as { local_key?: string }).local_key
    const { bridge, result } = await callBridge(target(localKey), op, params, callOptions)
    cached = bridge
    return { bridgePid: bridge.pid, result }
  }
  return {
    async locate(localKey) {
      if (cached) return cached.pid
      const [first] = await discoverBridges(target(localKey))
      cached = first
      return first?.pid
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
