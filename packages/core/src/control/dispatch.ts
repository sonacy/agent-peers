/**
 * Request dispatch for the control server: validation, per-op timeouts, the single-waiter rule for
 * `wait`, and result checking. Transport-free so it can be tested without sockets.
 */
import { decodeFrame, encodeError, encodeResult, PeersError, type RpcId } from '@agent-peers/protocol'
import { type Clock, systemClock } from '../util/clock'
import {
  type ControlHandler,
  type ControlOp,
  type Injected,
  isControlOp,
  MAX_CONTROL_LINE_BYTES,
  OP_SCHEMAS,
  type ParamsOf,
} from './ops'

export const DEFAULT_REQUEST_TIMEOUT_MS = 10_000

export interface DispatcherOptions {
  readonly handler: ControlHandler
  readonly requestTimeoutMs?: number
  readonly clock?: Clock
}

type Outcome = { readonly kind: 'value'; readonly value: unknown } | { readonly kind: 'aborted' }

/** Resolves with the handler's value, or `aborted` as soon as the signal fires. */
function raceAbort(work: Promise<unknown>, signal: AbortSignal): Promise<Outcome> {
  if (signal.aborted) return Promise.resolve({ kind: 'aborted' })
  return new Promise<Outcome>((resolve, reject) => {
    const onAbort = () => resolve({ kind: 'aborted' })
    signal.addEventListener('abort', onAbort, { once: true })
    work.then(
      (value) => {
        signal.removeEventListener('abort', onAbort)
        resolve({ kind: 'value', value })
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort)
        reject(error)
      },
    )
  })
}

const isInjected = (value: unknown): value is Injected =>
  typeof value === 'object' && value !== null && typeof (value as Injected).inject_id === 'string'

export class Dispatcher {
  private readonly waiters = new Map<string, AbortController>()
  private readonly clock: Clock

  constructor(private readonly options: DispatcherOptions) {
    this.clock = options.clock ?? systemClock
  }

  /**
   * Handles one line. `connection` is aborted when the client goes away; `deliver` writes the reply
   * and returns false when it could not (closed socket).
   */
  async handleLine(line: string, connection: AbortSignal, deliver: (text: string) => boolean): Promise<void> {
    const frame = decodeFrame(line, MAX_CONTROL_LINE_BYTES)
    if (frame.type === 'invalid') {
      deliver(encodeError(frame.id, frame.error))
      return
    }
    if (frame.type !== 'request') {
      deliver(encodeError(null, new PeersError('invalid_request', 'expected a JSON-RPC request')))
      return
    }
    try {
      const op = frame.method
      if (!isControlOp(op)) throw new PeersError('method_not_found', `unknown control op "${op}"`)
      const parsed = OP_SCHEMAS[op].params.safeParse(frame.params ?? {})
      if (!parsed.success)
        throw new PeersError(
          'invalid_params',
          `${op}: ${parsed.error.issues[0]?.message ?? 'invalid params'}`,
        )
      await this.run(op, parsed.data as ParamsOf<typeof op>, frame.id, connection, deliver)
    } catch (error) {
      deliver(encodeError(frame.id, error))
    }
  }

  private async run<Op extends ControlOp>(
    op: Op,
    params: ParamsOf<Op>,
    id: RpcId,
    connection: AbortSignal,
    deliver: (text: string) => boolean,
  ): Promise<void> {
    const controller = new AbortController()
    const abort = () => controller.abort()
    connection.addEventListener('abort', abort, { once: true })
    const isWait = op === 'wait'
    const localKey = params.local_key
    if (isWait) this.claimWaiter(localKey, controller)
    const timeoutMs = isWait ? (params as ParamsOf<'wait'>).timeout_ms : this.timeoutMs()
    let timedOut = false
    const timer = this.clock.setTimeout(() => {
      timedOut = true
      controller.abort()
    }, timeoutMs)
    try {
      const call = this.call(op, params, controller.signal)
      const outcome = await raceAbort(call, controller.signal)
      if (outcome.kind === 'aborted') {
        this.reclaimLate(call, localKey)
        if (connection.aborted) return
        if (isWait) deliver(encodeResult(id, null))
        else if (timedOut)
          deliver(encodeError(id, new PeersError('internal', `${op} timed out after ${timeoutMs} ms`)))
        return
      }
      const result = OP_SCHEMAS[op].result.safeParse(outcome.value)
      if (!result.success) throw new PeersError('internal', `${op}: the bridge returned an invalid result`)
      const delivered = !connection.aborted && deliver(encodeResult(id, result.data))
      if (isInjected(result.data)) this.settleInjected(op, localKey, result.data, delivered)
    } finally {
      this.clock.clearTimeout(timer)
      connection.removeEventListener('abort', abort)
      if (isWait && this.waiters.get(localKey) === controller) this.waiters.delete(localKey)
    }
  }

  private settleInjected(op: ControlOp, localKey: string, injected: Injected, delivered: boolean): void {
    const handler = this.options.handler
    if (!delivered) handler.undelivered?.(localKey, injected)
    else if (op === 'take' || op === 'wait') handler.delivered?.(localKey, op, injected)
  }

  /** A newer `wait` for the same key makes the older one return null at once. */
  private claimWaiter(localKey: string, controller: AbortController): void {
    this.waiters.get(localKey)?.abort()
    this.waiters.set(localKey, controller)
  }

  /** If an aborted handler still produces an envelope, hand it back so it is re-queued. */
  private reclaimLate(call: Promise<unknown>, localKey: string): void {
    call.then(
      (value) => {
        if (isInjected(value)) this.options.handler.undelivered?.(localKey, value)
      },
      () => undefined,
    )
  }

  private call<Op extends ControlOp>(op: Op, params: ParamsOf<Op>, signal: AbortSignal): Promise<unknown> {
    const handler = this.options.handler
    const ctx = { signal }
    // Each op's params type matches its method; the map keeps that link without a cast per case.
    const methods: { readonly [K in ControlOp]: (p: ParamsOf<K>) => Promise<unknown> } = {
      register: (p) => handler.register(p, ctx),
      activity: (p) => handler.activity(p, ctx),
      take: (p) => handler.take(p, ctx),
      wait: (p) => handler.wait(p, ctx),
      turn_end: (p) => handler.turn_end(p, ctx),
      end: (p) => handler.end(p, ctx),
      gate: (p) => handler.gate(p, ctx),
      permission: (p) => handler.permission(p, ctx),
      autojoin: (p) => handler.autojoin(p, ctx),
    }
    try {
      return (methods[op] as (p: ParamsOf<Op>) => Promise<unknown>)(params)
    } catch (error) {
      return Promise.reject(error)
    }
  }

  private timeoutMs(): number {
    return this.options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
  }

  /** Aborts every pending wait (server shutdown). */
  abortAll(): void {
    for (const controller of this.waiters.values()) controller.abort()
    this.waiters.clear()
  }
}
