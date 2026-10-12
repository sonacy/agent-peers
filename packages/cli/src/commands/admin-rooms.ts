/** Room and invite reads over the admin API, shared by `rooms` and `invite`. */
import { PeersError } from '@agent-peers/protocol'
import { type AdminClient, arrayField, field, isRecord, numberField, stringField } from './admin-client'

export interface AdminRoomRow {
  readonly room_id: string
  readonly name: string
  readonly display_name: string | undefined
  readonly people: number
  readonly agents: number
  readonly open_asks: number
  readonly pending_knocks: number
  readonly last_activity_at: number | null
}

export interface AdminInviteRow {
  readonly invite_id: string
  readonly room_id: string
  readonly code_masked: string
}

function parseRoom(value: unknown): AdminRoomRow {
  const room = field(value, 'room')
  const display = isRecord(room) ? room.display_name : undefined
  const last = field(value, 'last_activity_at')
  return {
    room_id: stringField(room, 'room_id'),
    name: stringField(room, 'name'),
    display_name: typeof display === 'string' ? display : undefined,
    people: numberField(value, 'people'),
    agents: numberField(value, 'agents'),
    open_asks: numberField(value, 'open_asks'),
    pending_knocks: numberField(value, 'pending_knocks'),
    last_activity_at: typeof last === 'number' ? last : null,
  }
}

function parseInvite(value: unknown): AdminInviteRow {
  return {
    invite_id: stringField(value, 'invite_id'),
    room_id: stringField(value, 'room_id'),
    code_masked: stringField(value, 'code_masked'),
  }
}

export async function listRooms(client: AdminClient): Promise<readonly AdminRoomRow[]> {
  return arrayField(await client.request('GET', '/v0/admin/rooms'), 'rooms').map(parseRoom)
}

export async function listInvites(client: AdminClient): Promise<readonly AdminInviteRow[]> {
  return arrayField(await client.request('GET', '/v0/admin/invites'), 'invites').map(parseInvite)
}

/** A room by name (case-insensitive) or id; `room_not_found` names the rooms that exist. */
export function findRoom(rooms: readonly AdminRoomRow[], ref: string): AdminRoomRow {
  const lower = ref.toLowerCase()
  const found = rooms.find((room) => room.room_id === ref || room.name.toLowerCase() === lower)
  if (found !== undefined) return found
  const names = rooms.map((room) => room.name).join(', ') || 'none'
  throw new PeersError(
    'room_not_found',
    `no room "${ref}" on this hub (rooms: ${names}); pass --create to make it`,
  )
}

export async function createRoom(client: AdminClient, name: string): Promise<AdminRoomRow> {
  const created = await client.request('POST', '/v0/admin/rooms', { name, discoverable: false })
  return parseRoom({ room: field(created, 'room'), last_activity_at: null })
}
