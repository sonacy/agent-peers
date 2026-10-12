/**
 * Wraps the MCP transport to see `initialize` before the SDK answers it: the bridge verifies the
 * surface from `clientInfo` right there (ARCHITECTURE §6.2) and, when it stays inert, replaces the
 * server `instructions` in the initialize result so the client is not told to use absent tools.
 */
import type { Transport, TransportSendOptions } from '@modelcontextprotocol/sdk/shared/transport.js'
import {
  type Implementation,
  isJSONRPCRequest,
  isJSONRPCResultResponse,
  type JSONRPCMessage,
  type MessageExtraInfo,
  type RequestId,
} from '@modelcontextprotocol/sdk/types.js'

export interface GuardHooks {
  /** Called with the client's `clientInfo` when `initialize` arrives, before the SDK handles it. */
  onInitialize(client: Implementation | undefined): void
  /** Instructions to send in the initialize result. */
  instructions(): string
}

function clientInfoOf(params: unknown): Implementation | undefined {
  if (typeof params !== 'object' || params === null) return undefined
  const info = (params as { clientInfo?: unknown }).clientInfo
  if (typeof info !== 'object' || info === null) return undefined
  const { name, version, title } = info as Record<string, unknown>
  if (typeof name !== 'string') return undefined
  return {
    name,
    version: typeof version === 'string' ? version : '',
    ...(typeof title === 'string' ? { title } : {}),
  }
}

export class GuardTransport implements Transport {
  onclose?: () => void
  onerror?: (error: Error) => void
  onmessage?: <T extends JSONRPCMessage>(message: T, extra?: MessageExtraInfo) => void
  private initializeId: RequestId | undefined

  constructor(
    private readonly inner: Transport,
    private readonly hooks: GuardHooks,
  ) {}

  get sessionId(): string | undefined {
    return this.inner.sessionId
  }

  setProtocolVersion(version: string): void {
    this.inner.setProtocolVersion?.(version)
  }

  start(): Promise<void> {
    this.inner.onclose = () => this.onclose?.()
    this.inner.onerror = (error) => this.onerror?.(error)
    this.inner.onmessage = (message, extra) => {
      if (isJSONRPCRequest(message) && message.method === 'initialize') {
        this.initializeId = message.id
        this.hooks.onInitialize(clientInfoOf(message.params))
      }
      this.onmessage?.(message, extra)
    }
    return this.inner.start()
  }

  send(message: JSONRPCMessage, options?: TransportSendOptions): Promise<void> {
    if (
      this.initializeId !== undefined &&
      isJSONRPCResultResponse(message) &&
      message.id === this.initializeId
    ) {
      this.initializeId = undefined
      const result = { ...message.result, instructions: this.hooks.instructions() }
      return this.inner.send({ ...message, result }, options)
    }
    return this.inner.send(message, options)
  }

  close(): Promise<void> {
    return this.inner.close()
  }
}
