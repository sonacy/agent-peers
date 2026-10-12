/**
 * Control-socket client for hook processes and the CLI: one request per connection (hooks are
 * short-lived), plus discovery helpers that pick the right bridge (ARCHITECTURE §5).
 */
import { decodeFrame, encodeRequest, fromRpcError, PeersError, toPeersError } from '@agent-peers/protocol'
import type { Socket } from 'bun'
import { LineReader, LineWriter } from './lines'
import { type ControlOp, MAX_CONTROL_LINE_BYTES, OP_SCHEMAS, type ParamsInputOf, type ResultOf } from './ops'
import type { ProcessTree } from './process-tree'
import { type BridgeInfo, discoverBridges } from './registry'

export const DEFAULT_CALL_TIMEOUT_MS = 5_000
/** Extra time a `wait` call allows beyond its `timeout_ms` before giving up on the bridge. */
export const WAIT_GRACE_MS = 5_000

export interface CallOptions {
  readonly timeoutMs?: number
}

const REQUEST_ID = 1

function defaultTimeout<Op extends ControlOp>(op: Op, params: ParamsInputOf<Op>): number {
  if (op !== 'wait') return DEFAULT_CALL_TIMEOUT_MS
  return (params as ParamsInputOf<'wait'>).timeout_ms + WAIT_GRACE_MS
}

function parseReply<Op extends ControlOp>(op: Op, line: string): ResultOf<Op> | PeersError | undefined {
  const frame = decodeFrame(line, MAX_CONTROL_LINE_BYTES)
  if (frame.type === 'error')
    return frame.id === REQUEST_ID || frame.id === null ? fromRpcError(frame.error) : undefined
  if (frame.type !== 'result' || frame.id !== REQUEST_ID) return undefined
  const parsed = OP_SCHEMAS[op].result.safeParse(frame.result)
  return parsed.success
    ? (parsed.data as ResultOf<Op>)
    : new PeersError('invalid_result', `${op}: the bridge sent an invalid result`)
}

/** Sends one request to the bridge at `socketPath` and resolves with its validated result. */
export function callControl<Op extends ControlOp>(
  socketPath: string,
  op: Op,
  params: ParamsInputOf<Op>,
  options: CallOptions = {},
): Promise<ResultOf<Op>> {
  const request = encodeRequest(REQUEST_ID, op, params, MAX_CONTROL_LINE_BYTES)
  const timeoutMs = options.timeoutMs ?? defaultTimeout(op, params)
  return new Promise<ResultOf<Op>>((resolve, reject) => {
    const reader = new LineReader(MAX_CONTROL_LINE_BYTES)
    let settled = false
    let socket: Socket<undefined> | undefined
    let writer: LineWriter | undefined
    const finish = (outcome: { value: ResultOf<Op> } | { error: PeersError }) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      socket?.end()
      if ('value' in outcome) resolve(outcome.value)
      else reject(outcome.error)
    }
    const timer = setTimeout(
      () =>
        finish({
          error: new PeersError('timeout', `${op}: no answer from the bridge within ${timeoutMs} ms`),
        }),
      timeoutMs,
    )
    const onData = (chunk: Uint8Array) => {
      for (const event of reader.push(chunk)) {
        if ('overflow' in event)
          return finish({ error: new PeersError('invalid_frame', 'reply line too long') })
        const reply = parseReply(op, event.line)
        if (reply instanceof PeersError) return finish({ error: reply })
        if (reply !== undefined) return finish({ value: reply })
      }
    }
    Bun.connect<undefined>({
      unix: socketPath,
      socket: {
        open: (s) => {
          writer = new LineWriter(s)
          writer.writeLine(request)
        },
        drain: () => writer?.drain(),
        data: (_s, chunk) => onData(chunk),
        close: () =>
          finish({ error: new PeersError('disconnected', `${op}: the bridge closed the connection`) }),
        error: (_s, error) => finish({ error: toPeersError(error, 'disconnected') }),
        connectError: (_s, error) => finish({ error: toPeersError(error, 'not_connected') }),
      },
    }).then(
      (s) => {
        socket = s
        if (settled) s.end()
      },
      (error: unknown) => finish({ error: toPeersError(error, 'not_connected') }),
    )
  })
}

export interface BridgeTarget {
  readonly runDir: string
  readonly localKey?: string
  readonly pid?: number
  readonly tree?: ProcessTree
}

/** Sends to the best bridge for this process; tries the next one when a bridge is unreachable. */
export async function callBridge<Op extends ControlOp>(
  target: BridgeTarget,
  op: Op,
  params: ParamsInputOf<Op>,
  options: CallOptions = {},
): Promise<{ readonly bridge: BridgeInfo; readonly result: ResultOf<Op> }> {
  const bridges = await discoverBridges({
    ...target,
    ...(target.localKey ? { localKey: target.localKey } : {}),
  })
  if (bridges.length === 0)
    throw new PeersError('not_connected', 'no agent-peers bridge found for this agent process')
  let lastError: PeersError | undefined
  for (const bridge of bridges) {
    try {
      return { bridge, result: await callControl(bridge.socket, op, params, options) }
    } catch (error) {
      lastError = toPeersError(error)
      if (lastError.code !== 'not_connected') throw lastError
    }
  }
  throw lastError ?? new PeersError('not_connected', 'no reachable bridge')
}

export type BroadcastResult<Op extends ControlOp> =
  | { readonly bridge: BridgeInfo; readonly ok: true; readonly result: ResultOf<Op> }
  | { readonly bridge: BridgeInfo; readonly ok: false; readonly error: PeersError }

/** Sends to every matching bridge (ARCHITECTURE §5: `register` goes to all of them). */
export async function broadcastToBridges<Op extends ControlOp>(
  bridges: readonly BridgeInfo[],
  op: Op,
  params: ParamsInputOf<Op>,
  options: CallOptions = {},
): Promise<readonly BroadcastResult<Op>[]> {
  return Promise.all(
    bridges.map(async (bridge): Promise<BroadcastResult<Op>> => {
      try {
        return { bridge, ok: true, result: await callControl(bridge.socket, op, params, options) }
      } catch (error) {
        return { bridge, ok: false, error: toPeersError(error) }
      }
    }),
  )
}
