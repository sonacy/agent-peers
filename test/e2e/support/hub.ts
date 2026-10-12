/**
 * A real hub for e2e runs: in-memory SQLite, both listeners on port 0 (loopback), no bootstrap room.
 * The admin API is driven like `agent-peers invite` on the hub host does it: a bearer admin token.
 */
import { createHub, type Hub, silentLogger } from './deps'

export interface CardView {
  readonly session_id: string
  readonly member: string
  readonly agent: { readonly kind: string }
  readonly title?: string
  readonly inject: string
  readonly connection: string
  readonly activity: string
  readonly rooms: readonly { readonly room_id: string; readonly handle: string }[]
}

export interface MessageView {
  readonly id: string
  readonly kind: string
  readonly text: string
  readonly to: readonly string[]
  readonly re?: string | null
  readonly from?: { readonly handle?: string; readonly member?: string }
  readonly ask?: { readonly state: string; readonly reason?: string }
}

export interface E2eRoom {
  readonly roomId: string
  readonly name: string
  readonly inviteUrl: string
}

export interface E2eHub {
  readonly hub: Hub
  /** `http://127.0.0.1:<port>`: the hub origin bridges store credentials under. */
  readonly url: string
  readonly adminUrl: string
  createRoom(name: string): Promise<E2eRoom>
  sessions(): Promise<readonly CardView[]>
  /** Live (not closed) sessions of a member, newest first. */
  sessionsOf(member: string): Promise<readonly CardView[]>
  messages(roomId: string): Promise<readonly MessageView[]>
  ask(roomId: string, askId: string): Promise<MessageView | undefined>
  renameHandle(roomId: string, handle: string, to: string): Promise<Response>
  stop(): Promise<void>
}

async function json<T>(response: Response, what: string): Promise<T> {
  if (!response.ok) throw new Error(`${what}: HTTP ${response.status} ${await response.text()}`)
  return (await response.json()) as T
}

export async function startE2eHub(): Promise<E2eHub> {
  const hub = createHub({
    publicBind: '127.0.0.1',
    publicPort: 0,
    adminPort: 0,
    dataDir: ':memory:',
    bootstrapDefaultRoom: false,
    logger: silentLogger,
  })
  const info = await hub.start()
  const url = `http://127.0.0.1:${info.publicPort}`
  const adminUrl = `http://127.0.0.1:${info.adminPort}`
  const headers = { authorization: `Bearer ${info.adminToken}`, 'content-type': 'application/json' }
  const admin = (path: string, init: RequestInit = {}) =>
    fetch(`${adminUrl}/v0/admin${path}`, { ...init, headers: { ...headers, ...init.headers } })

  const sessions = async () =>
    (await json<{ sessions: CardView[] }>(await admin('/sessions'), 'admin sessions')).sessions
  const messages = async (roomId: string) =>
    (
      await json<{ messages: MessageView[] }>(
        await admin(`/rooms/${roomId}/messages?limit=200`),
        'admin messages',
      )
    ).messages

  return {
    hub,
    url,
    adminUrl,
    async createRoom(name) {
      const created = await json<{ room: { room_id: string; name: string }; invite_url: string | null }>(
        await admin('/rooms', { method: 'POST', body: JSON.stringify({ name }) }),
        'admin create room',
      )
      if (!created.invite_url) throw new Error('the hub created no invite')
      return { roomId: created.room.room_id, name: created.room.name, inviteUrl: created.invite_url }
    },
    sessions,
    async sessionsOf(member) {
      return (await sessions()).filter((card) => card.member === member).reverse()
    },
    messages,
    async ask(roomId, askId) {
      return (await messages(roomId)).find((m) => m.id === askId)
    },
    renameHandle: (roomId, handle, to) =>
      admin(`/rooms/${roomId}/handles/${handle}`, { method: 'PATCH', body: JSON.stringify({ handle: to }) }),
    stop: () => hub.stop(),
  }
}
