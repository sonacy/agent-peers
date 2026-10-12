/**
 * A short-lived hub session for `join` (the bootstrap bridge, ONBOARDING §3 step 5) and the shell
 * fallback commands: hello, `session.open`, the work, then `session.close` / `bye`. No reconnect:
 * a dropped connection fails the command instead of retrying behind the user's back.
 */
import { HubClient, SessionHandle, type WebSocketFactory } from '@agent-peers/core'
import type { AgentKind, CardInput } from '@agent-peers/protocol'

export interface HubSessionSpec {
  readonly origin: string
  readonly token: string
  readonly kind: AgentKind
  readonly agentVersion?: string
  readonly adapter: string
  readonly host: string
  readonly localKey: string
  readonly card: CardInput
  readonly insecure?: boolean
  readonly webSocketFactory?: WebSocketFactory
  readonly requestTimeoutMs?: number
}

export interface HubSession {
  readonly client: HubClient
  readonly session: SessionHandle
  /** `session.close` (when asked and still open), then `bye` and the socket. */
  close(closeSession: boolean): Promise<void>
}

const DEFAULT_REQUEST_TIMEOUT_MS = 20_000

export function newHubClient(spec: HubSessionSpec): HubClient {
  return new HubClient({
    bridge: {
      agent_kind: spec.kind,
      adapter: spec.adapter,
      host: spec.host,
      ...(spec.agentVersion ? { agent_version: spec.agentVersion.slice(0, 64) } : {}),
    },
    reconnect: false,
    requestTimeoutMs: spec.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
    ...(spec.insecure ? { insecure: true } : {}),
    ...(spec.webSocketFactory ? { webSocketFactory: spec.webSocketFactory } : {}),
  })
}

export async function openHubSession(spec: HubSessionSpec): Promise<HubSession> {
  const client = newHubClient(spec)
  try {
    await client.connect(spec.origin, spec.token)
  } catch (error) {
    await client.close()
    throw error
  }
  const session = new SessionHandle(client, { localKey: spec.localKey, card: spec.card })
  try {
    await session.open()
  } catch (error) {
    session.dispose()
    await client.close()
    throw error
  }
  return {
    client,
    session,
    async close(closeSession: boolean) {
      try {
        if (closeSession && session.view.status === 'open') await session.close()
      } finally {
        session.dispose()
        await client.close()
      }
    },
  }
}
