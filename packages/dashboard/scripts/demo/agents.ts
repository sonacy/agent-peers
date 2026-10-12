/**
 * Demo bridges: each agent is a real core `HubClient` + `SessionHandle`, exactly like a bridge
 * process, so every seeded fact goes through the hub's WebSocket API. Clients keep heartbeating (and
 * reconnecting) until they are closed.
 */
import {
  type Activity,
  type AgentKind,
  HubClient,
  type InjectTier,
  parseInviteUrl,
  SessionHandle,
} from '@agent-peers/core'

export const DEMO_ADAPTER = '0.1.0'

export interface AgentSpec {
  /** Stable local key (unique per member). */
  readonly key: string
  readonly kind: AgentKind
  readonly title: string
  readonly model?: string
  readonly inject?: InjectTier
  readonly workspace?: string
  readonly activity?: Activity
  readonly summary?: string
  readonly adapter?: string
}

export interface DemoAgent {
  readonly member: string
  readonly spec: AgentSpec
  readonly client: HubClient
  readonly handle: SessionHandle
  readonly sessionId: string
  /** Creates a room owned by this agent's member; returns its id and invite code. */
  createRoom(input: CreateRoomInput): Promise<CreatedDemoRoom>
  join(roomId: string, handle: string): Promise<void>
  joinByInvite(code: string, handle: string): Promise<string>
  /** Sends an ask; returns the ask id. */
  ask(roomId: string, to: string, text: string, ttlMs?: number): Promise<string>
  /** Says `bye`: the session goes offline at once but keeps its handles. */
  disconnect(): Promise<void>
}

export interface CreateRoomInput {
  readonly name: string
  readonly handle: string
  readonly displayName?: string
  readonly description?: string
  readonly discoverable?: boolean
}

export interface CreatedDemoRoom {
  readonly roomId: string
  readonly inviteCode: string
}

export interface ConnectOptions {
  /** Keep reconnecting if the hub restarts (the long-running demo); off in tests. */
  readonly reconnect?: boolean
}

function cardFor(spec: AgentSpec) {
  return {
    agent: { kind: spec.kind, adapter: spec.adapter ?? DEMO_ADAPTER },
    host: 'demo-mbp',
    title: spec.title,
    inject: spec.inject ?? 'push',
    activity: spec.activity ?? 'idle',
    accepting: true,
    ...(spec.model === undefined ? {} : { model: spec.model }),
    ...(spec.summary === undefined ? {} : { summary: spec.summary }),
    ...(spec.workspace === undefined ? {} : { workspace: { name: spec.workspace } }),
  }
}

export async function connectAgent(
  hubUrl: string,
  token: string,
  member: string,
  spec: AgentSpec,
  options: ConnectOptions = {},
): Promise<DemoAgent> {
  const client = new HubClient({
    bridge: { agent_kind: spec.kind, adapter: spec.adapter ?? DEMO_ADAPTER, host: 'demo-mbp' },
    reconnect: options.reconnect ?? false,
  })
  await client.connect(hubUrl, token)
  const handle = new SessionHandle(client, { localKey: `${member}-${spec.key}`, card: cardFor(spec) })
  await handle.open()
  const sessionId = handle.sessionId
  return {
    member,
    spec,
    client,
    handle,
    sessionId,
    async createRoom(input) {
      const created = await client.request('room.create', {
        session_id: sessionId,
        name: input.name,
        handle: input.handle,
        discoverable: input.discoverable ?? true,
        ...(input.displayName === undefined ? {} : { display_name: input.displayName }),
        ...(input.description === undefined ? {} : { description: input.description }),
      })
      return { roomId: created.room.room_id, inviteCode: parseInviteUrl(created.invite_url).code }
    },
    async join(roomId, name) {
      await handle.join({ room_id: roomId, handle: name })
    },
    async joinByInvite(code, name) {
      return (await handle.join({ invite_code: code, handle: name })).room.room_id
    },
    async ask(roomId, to, text, ttlMs) {
      const sent = await handle.ask({
        room_id: roomId,
        to,
        text,
        ...(ttlMs === undefined ? {} : { ttl_ms: ttlMs }),
      })
      return sent.id
    },
    async disconnect() {
      await client.close('demo: offline')
    },
  }
}
