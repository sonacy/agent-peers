/**
 * The bridge's single hub connection (ARCHITECTURE §2: one connection multiplexes every session),
 * opened lazily from `credentials.json` the first time a session needs it.
 */
import {
  type Clock,
  type Credential,
  HubClient,
  type HubClientOptions,
  hubOrigin,
  type LocalConfig,
  type LocalHome,
  PeersError,
} from '@agent-peers/core'
import type { BridgeInfo } from '@agent-peers/protocol'

export type HubClientFactory = (options: HubClientOptions) => HubClient

export const defaultHubClientFactory: HubClientFactory = (options) => new HubClient(options)

export interface Connected {
  readonly client: HubClient
  /** Hub origin (`https://hub.example.com`). */
  readonly hub: string
  readonly member: string | undefined
}

export interface HubConnectionOptions {
  readonly home: LocalHome
  readonly bridge: () => BridgeInfo
  readonly config: () => Promise<LocalConfig>
  readonly factory: HubClientFactory
  readonly clock?: Clock
  readonly insecure?: boolean
  readonly log: (line: string) => void
}

/** Picks the hub: the requested one, else `default_hub` when we hold a token for it, else the only one. */
export function pickHub(
  hubs: Readonly<Record<string, Credential>>,
  defaultHub: string | undefined,
  requested: string | undefined,
): string {
  if (requested !== undefined) return hubOrigin(requested)
  const origins = Object.keys(hubs)
  if (defaultHub !== undefined && origins.includes(hubOrigin(defaultHub))) return hubOrigin(defaultHub)
  if (origins.length === 1) return origins[0] as string
  if (origins.length === 0)
    throw new PeersError(
      'unauthorized',
      'not joined to any hub yet: use peers_join with an invite link first',
    )
  throw new PeersError(
    'invalid_params',
    `tokens for several hubs (${origins.join(', ')}): set default_hub in ~/.agent-peers/config.json`,
  )
}

export class HubConnection {
  private pending: Promise<Connected> | undefined
  private connected: Connected | undefined
  private lostListeners: readonly (() => void)[] = []

  constructor(private readonly options: HubConnectionOptions) {}

  /** The connected hub's origin, if any. */
  get hub(): string | undefined {
    return this.connected?.hub
  }

  get current(): Connected | undefined {
    return this.connected
  }

  /** Called when the connection closed for good (token revoked, bridge closing). */
  onLost(listener: () => void): () => void {
    this.lostListeners = [...this.lostListeners, listener]
    return () => {
      this.lostListeners = this.lostListeners.filter((l) => l !== listener)
    }
  }

  /** Connects once; later calls reuse the connection. A second, different hub is refused (v0). */
  async ensure(requestedHub?: string): Promise<Connected> {
    const wanted = requestedHub === undefined ? undefined : hubOrigin(requestedHub)
    const existing = this.connected
    if (existing) {
      if (wanted !== undefined && wanted !== existing.hub) throw this.otherHub(existing.hub, wanted)
      return existing
    }
    if (!this.pending) {
      this.pending = this.open(wanted)
      this.pending.catch(() => {
        this.pending = undefined
      })
    }
    const connected = await this.pending
    if (wanted !== undefined && wanted !== connected.hub) throw this.otherHub(connected.hub, wanted)
    return connected
  }

  private otherHub(current: string, wanted: string): PeersError {
    return new PeersError(
      'forbidden',
      `this agent is connected to ${new URL(current).host}; joining a second hub (${new URL(wanted).host}) needs a restart of the agent in v0`,
    )
  }

  private async open(requested: string | undefined): Promise<Connected> {
    const config = await this.options.config()
    const { hubs } = await this.options.home.readCredentials()
    const hub = pickHub(hubs, config.default_hub, requested)
    const credential = hubs[hub]
    if (!credential) throw new PeersError('unauthorized', `no member token for ${new URL(hub).host}`)
    const client = this.options.factory({
      bridge: this.options.bridge(),
      ...(this.options.clock ? { clock: this.options.clock } : {}),
      ...(this.options.insecure ? { insecure: true } : {}),
    })
    client.onLifecycle((event) => {
      if (event.type === 'closed') this.handleClosed(client, event.reason)
    })
    await client.connect(hub, credential.member_token)
    const connected: Connected = { client, hub, member: credential.member }
    this.connected = connected
    this.pending = undefined
    this.options.log(`connected to ${new URL(hub).host}`)
    return connected
  }

  private handleClosed(client: HubClient, reason: string): void {
    if (this.connected?.client !== client) return
    this.connected = undefined
    this.options.log(`hub connection closed: ${reason}`)
    for (const listener of this.lostListeners) listener()
  }

  async close(): Promise<void> {
    const connected = this.connected
    this.connected = undefined
    this.lostListeners = []
    if (connected) await connected.client.close('bridge shutting down')
  }
}
