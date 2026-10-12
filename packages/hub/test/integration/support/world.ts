/**
 * L2 integration world: the real hub (createHub, ':memory:', port 0, fake hub clock) driven by the
 * real @agent-peers/core HubClient and SessionHandle over real WebSockets.
 *
 * The hub runs on a FakeClock, so heartbeat staleness, grace, TTLs and cooldowns only move when a
 * test advances it. Clients run on real time with a short reconnect backoff and a heartbeat long
 * enough that no ping fires during a test.
 */
import { type CardInput, HubClient, SessionHandle } from '@agent-peers/core'
import { silentLogger } from '../../../src/config'
import { type CreateHubOptions, createHub, type Hub } from '../../../src/hub'
import { FakeClock } from '../../helpers/fake-clock'
import { Inbox } from './inbox'
import { SocketTap } from './tap'

export const HEARTBEAT_MS = 10_000
export const GRACE_MS = 2_000
const CLIENT_HEARTBEAT_MS = 60_000
const REQUEST_TIMEOUT_MS = 3_000

export interface PeerOptions {
  readonly localKey?: string
  readonly host?: string
  readonly title?: string
  readonly supersedes?: string
  /** `false` disables auto-reconnect (a crash then stays down). */
  readonly reconnect?: boolean
}

export interface Peer {
  readonly member: string
  readonly memberId: string
  readonly token: string
  readonly client: HubClient
  readonly session: SessionHandle
  readonly inbox: Inbox
  readonly tap: SocketTap
  /** The hub-assigned session id (throws if the session is not open). */
  readonly id: string
}

export interface CreatedRoom {
  readonly roomId: string
  readonly code: string
  readonly inviteUrl: string
}

export interface World {
  readonly hub: Hub
  readonly clock: FakeClock
  readonly url: string
  /** A member (created on first use), a connected client and an opened session. */
  peer(member: string, options?: PeerOptions): Promise<Peer>
  /** A connected client for `member` whose session is not opened yet. */
  connect(member: string, options?: PeerOptions): Promise<Peer>
  createRoom(owner: Peer, name: string, handle: string): Promise<CreatedRoom>
  /** Owner `owner` creates `name` as `@ownerHandle`; `guest` joins by invite code as `@guestHandle`. */
  pair(owner: Peer, guest: Peer, handles?: { owner?: string; guest?: string }): Promise<CreatedRoom>
  sessionRow(
    sessionId: string,
  ): { readonly connection: string; readonly closed_at: number | null } | undefined
  stop(): Promise<void>
}

export function cardFor(member: string, options: PeerOptions = {}): CardInput {
  return {
    agent: { kind: 'claude-code', version: '2.1.0', adapter: '0.3.0' },
    host: options.host ?? `${member}-laptop`,
    workspace: { name: 'payments-api', branch: 'main' },
    ...(options.title !== undefined ? { title: options.title } : {}),
  }
}

export async function startWorld(options: CreateHubOptions = {}): Promise<World> {
  const clock = new FakeClock()
  const hub = createHub({
    publicBind: '127.0.0.1',
    publicPort: 0,
    adminPort: 0,
    heartbeatMs: HEARTBEAT_MS,
    graceMs: GRACE_MS,
    logger: silentLogger,
    clock,
    ...options,
  })
  const info = await hub.start()
  const url = `http://127.0.0.1:${info.publicPort}`
  const members = new Map<string, { readonly id: string; readonly token: string }>()
  let peers: readonly Peer[] = []
  let keys = 0

  const member = (name: string) => {
    const known = members.get(name)
    if (known) return known
    const issued = hub.services.members.create(name)
    const created = { id: issued.member.id, token: issued.token }
    members.set(name, created)
    return created
  }

  const connect = async (name: string, options: PeerOptions = {}): Promise<Peer> => {
    const { id: memberId, token } = member(name)
    const tap = new SocketTap()
    const host = options.host ?? `${name}-laptop`
    const client = new HubClient({
      bridge: { agent_kind: 'claude-code', agent_version: '2.1.0', adapter: '0.3.0', host },
      requestTimeoutMs: REQUEST_TIMEOUT_MS,
      heartbeatMs: CLIENT_HEARTBEAT_MS,
      reconnect: options.reconnect === false ? false : { initialMs: 20, maxMs: 80, jitter: 0 },
      webSocketFactory: tap.factory,
    })
    const inbox = new Inbox(client)
    keys += 1
    const session = new SessionHandle(client, {
      localKey: options.localKey ?? `${name}-conv-${keys}`,
      card: cardFor(name, options),
      ...(options.supersedes !== undefined ? { supersedes: options.supersedes } : {}),
    })
    await client.connect(url, token)
    const peer: Peer = {
      member: name,
      memberId,
      token,
      client,
      session,
      inbox,
      tap,
      get id() {
        return session.sessionId
      },
    }
    peers = [...peers, peer]
    return peer
  }

  const peer = async (name: string, options: PeerOptions = {}): Promise<Peer> => {
    const created = await connect(name, options)
    await created.session.open()
    return created
  }

  const createRoom = async (owner: Peer, name: string, handle: string): Promise<CreatedRoom> => {
    const created = await owner.client.request('room.create', { session_id: owner.id, name, handle })
    const code = created.invite_url.split('/').at(-1) ?? ''
    await owner.inbox.waitFor('replay.done', (n) => n.room_id === created.room.room_id)
    return { roomId: created.room.room_id, code, inviteUrl: created.invite_url }
  }

  const pair = async (
    owner: Peer,
    guest: Peer,
    handles: { owner?: string; guest?: string } = {},
  ): Promise<CreatedRoom> => {
    const room = await createRoom(owner, 'team', handles.owner ?? 'home')
    await guest.session.join({ invite_code: room.code, handle: handles.guest ?? 'work' })
    await guest.inbox.waitFor('replay.done', (n) => n.room_id === room.roomId)
    return room
  }

  const stop = async () => {
    await Promise.all(peers.map((p) => p.client.close()))
    for (const p of peers) p.session.dispose()
    await hub.stop()
  }

  return {
    hub,
    clock,
    url,
    peer,
    connect,
    createRoom,
    pair,
    sessionRow: (sessionId) => hub.services.deps.repos.sessions.byId(sessionId),
    stop,
  }
}

/** Resolves when the client has reconnected (hello + resync) after a drop. */
export function reconnected(client: HubClient): Promise<void> {
  return new Promise((resolve) => {
    const off = client.onLifecycle((event) => {
      if (event.type === 'connected' && event.reconnected) {
        off()
        resolve()
      }
    })
  })
}

/** The PeersError code a promise rejects with. */
export async function errorOf(promise: Promise<unknown>): Promise<{ code: string; retryAfterMs?: number }> {
  try {
    await promise
  } catch (error) {
    const e = error as { code?: unknown; retryAfterMs?: unknown }
    return {
      code: typeof e.code === 'string' ? e.code : 'non-peers-error',
      ...(typeof e.retryAfterMs === 'number' ? { retryAfterMs: e.retryAfterMs } : {}),
    }
  }
  throw new Error('expected the request to fail')
}
