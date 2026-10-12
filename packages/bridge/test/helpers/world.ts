/**
 * Test world: a real hub (createHub, ':memory:', port 0), remote peers driven by the real core
 * HubClient/SessionHandle, and bridges driven in-process by the MCP SDK client over an in-memory
 * transport pair. Every bridge gets a temp AGENT_PEERS_HOME; nothing touches the real home.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  type CardInput,
  HubClient,
  type HubClientOptions,
  LocalHome,
  NOTIFICATION_NAMES,
  type NotificationMap,
  type NotificationName,
  SessionHandle,
} from '@agent-peers/core'
import { createHub, type Hub, silentLogger } from '@agent-peers/hub'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { type Bridge, type BridgeOptions, createBridge } from '../../src/bridge'
import type { BridgeSurface } from '../../src/surface/surfaces'

export const WAIT_MS = 4000

export const testClientFactory = (options: HubClientOptions): HubClient =>
  new HubClient({
    ...options,
    heartbeatMs: 60_000,
    requestTimeoutMs: 3000,
    reconnect: { initialMs: 20, maxMs: 80, jitter: 0 },
  })

/** Records notifications of a HubClient and waits on them. */
export class Notes {
  private notes: readonly { name: NotificationName; params: unknown }[] = []
  private waiters: readonly { test: (n: { name: string; params: unknown }) => boolean; done: () => void }[] =
    []

  constructor(client: HubClient) {
    for (const name of NOTIFICATION_NAMES)
      client.on(name, (params) => {
        this.notes = [...this.notes, { name, params }]
        for (const w of this.waiters.filter((x) => x.test({ name, params }))) w.done()
      })
  }

  all<N extends NotificationName>(name: N): readonly NotificationMap[N][] {
    return this.notes.filter((n) => n.name === name).map((n) => n.params as NotificationMap[N])
  }

  waitFor<N extends NotificationName>(
    name: N,
    match: (p: NotificationMap[N]) => boolean = () => true,
  ): Promise<NotificationMap[N]> {
    const test = (n: { name: string; params: unknown }) =>
      n.name === name && match(n.params as NotificationMap[N])
    const seen = this.notes.find(test)
    if (seen) return Promise.resolve(seen.params as NotificationMap[N])
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timed out waiting for ${name}`)), WAIT_MS)
      const waiter = {
        test,
        done: () => {
          clearTimeout(timer)
          this.waiters = this.waiters.filter((w) => w !== waiter)
          const hit = [...this.notes].reverse().find(test)
          resolve(hit?.params as NotificationMap[N])
        },
      }
      this.waiters = [...this.waiters, waiter]
    })
  }
}

export interface Peer {
  readonly client: HubClient
  readonly session: SessionHandle
  readonly notes: Notes
  readonly token: string
}

export interface ToolOutput {
  readonly text: string
  readonly structured: Record<string, unknown> | undefined
  readonly isError: boolean
}

export interface BridgeHarness {
  readonly bridge: Bridge
  readonly client: Client
  readonly home: LocalHome
  readonly logs: string[]
  readonly opened: string[]
  call(name: string, args?: Record<string, unknown>, meta?: Record<string, unknown>): Promise<ToolOutput>
  tools(): Promise<readonly string[]>
  close(): Promise<void>
}

export interface HarnessOptions extends Partial<Omit<BridgeOptions, 'surface' | 'home'>> {
  readonly clientInfo?: { readonly name: string; readonly version: string; readonly title?: string }
  /** Seed credentials.json with this token for the world's hub. */
  readonly token?: string
  readonly homeDir?: string
}

const CLIENT_INFO: Readonly<Record<BridgeSurface, { name: string; version: string; title?: string }>> = {
  'claude-code': { name: 'claude-code', version: '2.1.296' },
  'claude-desktop': { name: 'claude-ai', version: '0.1.0' },
  codex: { name: 'codex-mcp-client', version: '0.160.1', title: 'Codex' },
  'codex-desktop': { name: 'codex-mcp-client', version: '0.160.1', title: 'Codex Desktop' },
}

export interface World {
  readonly hub: Hub
  readonly url: string
  readonly dir: string
  member(name: string): string
  peer(name: string, localKey?: string, card?: Partial<CardInput>): Promise<Peer>
  /** `owner` creates `room` and returns its invite code. */
  room(
    owner: Peer,
    name: string,
    handle: string,
  ): Promise<{ roomId: string; code: string; inviteUrl: string }>
  bridge(surface: BridgeSurface, options?: HarnessOptions): Promise<BridgeHarness>
  stop(): Promise<void>
}

export async function startWorld(): Promise<World> {
  const dir = await mkdtemp(join(tmpdir(), 'apb-'))
  const hub = createHub({ publicBind: '127.0.0.1', publicPort: 0, adminPort: 0, logger: silentLogger })
  const info = await hub.start()
  const url = `http://127.0.0.1:${info.publicPort}`
  const peers: Peer[] = []
  const harnesses: BridgeHarness[] = []
  let homes = 0
  const member = (name: string) => hub.services.members.create(name).token

  const peer = async (name: string, localKey = `${name}-conv`, card: Partial<CardInput> = {}) => {
    const token = member(name)
    const client = testClientFactory({
      bridge: { agent_kind: 'claude-code', agent_version: '2.1.0', adapter: '0.1.0', host: `${name}-laptop` },
    })
    const notes = new Notes(client)
    const session = new SessionHandle(client, {
      localKey,
      card: { agent: { kind: 'claude-code', adapter: '0.1.0' }, host: `${name}-laptop`, ...card },
    })
    await client.connect(url, token)
    await session.open()
    const created = { client, session, notes, token }
    peers.push(created)
    return created
  }

  const room = async (owner: Peer, name: string, handle: string) => {
    const created = await owner.client.request('room.create', {
      session_id: owner.session.sessionId,
      name,
      handle,
    })
    await owner.session.join({ room_id: created.room.room_id })
    const code = created.invite_url.split('/').at(-1) ?? ''
    return { roomId: created.room.room_id, code, inviteUrl: created.invite_url }
  }

  const bridge = async (surface: BridgeSurface, options: HarnessOptions = {}): Promise<BridgeHarness> => {
    homes += 1
    const homeDir = options.homeDir ?? join(dir, `home-${homes}`)
    const home = new LocalHome({ root: homeDir, userHome: dir })
    if (options.token) await home.setCredential(url, { member_token: options.token })
    const harness = await connectBridge(surface, home, { ...options, userHome: dir })
    harnesses.push(harness)
    return harness
  }

  const stop = async () => {
    await Promise.all(harnesses.map((h) => h.close()))
    await Promise.all(peers.map((p) => p.client.close()))
    for (const p of peers) p.session.dispose()
    await hub.stop()
    await rm(dir, { recursive: true, force: true })
  }

  return { hub, url, dir, member, peer, room, bridge, stop }
}

export async function connectBridge(
  surface: BridgeSurface,
  home: LocalHome,
  options: HarnessOptions,
): Promise<BridgeHarness> {
  const logs: string[] = []
  const opened: string[] = []
  const { clientInfo, token: _token, homeDir: _homeDir, ...rest } = options
  const bridge = createBridge({
    surface,
    home,
    env: {},
    host: 'testhost',
    controlSocket: false,
    hubClientFactory: testClientFactory,
    log: (line) => logs.push(line),
    openUrl: async (url) => {
      opened.push(url)
      return true
    },
    ...rest,
  })
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair()
  await bridge.connect(serverSide)
  const client = new Client(clientInfo ?? CLIENT_INFO[surface], { capabilities: {} })
  await client.connect(clientSide)
  await bridge.ready()
  let closed = false
  return {
    bridge,
    client,
    home,
    logs,
    opened,
    async call(name, args = {}, meta) {
      const result = await client.callTool({ name, arguments: args, ...(meta ? { _meta: meta } : {}) })
      const content = Array.isArray(result.content) ? result.content : []
      const first = content[0] as { type?: string; text?: string } | undefined
      return {
        text: first?.text ?? '',
        structured: result.structuredContent as Record<string, unknown> | undefined,
        isError: result.isError === true,
      }
    },
    async tools() {
      return (await client.listTools()).tools.map((t) => t.name)
    },
    async close() {
      if (closed) return
      closed = true
      await bridge.close()
      await client.close().catch(() => undefined)
    },
  }
}

/** Polls `check` until it returns a value (real time, short). */
export async function eventually<T>(
  check: () => T | undefined | Promise<T | undefined>,
  ms = WAIT_MS,
): Promise<T> {
  const deadline = Date.now() + ms
  for (;;) {
    const value = await check()
    if (value !== undefined) return value
    if (Date.now() > deadline) throw new Error('condition not met in time')
    await Bun.sleep(10)
  }
}
