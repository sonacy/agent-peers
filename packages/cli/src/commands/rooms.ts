/** `agent-peers rooms` on the hub host: every room with its people, agents, asks, knocks and invite. */
import { type Command, Command as CommanderCommand } from 'commander'
import { renderError } from '../errors'
import { type GlobalOptions, globalsOf } from '../globals'
import type { CliIo } from '../io'
import { type AdminClient, createAdminClient, resolveAdminTarget } from './admin-client'
import { type AdminRoomRow, listInvites, listRooms } from './admin-rooms'
import { addDataDirOption } from './hub-options'
import { type AdminCommandDeps, addAdminUrlOption, adminDataDir } from './invite'

export interface RoomsOptions {
  readonly dataDir?: string
  readonly adminUrl?: string
}

export interface RoomListing extends AdminRoomRow {
  /** The active invite's masked code, or null when invites are closed. */
  readonly invite: string | null
}

export async function roomListing(client: AdminClient): Promise<readonly RoomListing[]> {
  const [rooms, invites] = await Promise.all([listRooms(client), listInvites(client)])
  return rooms.map((room) => ({
    ...room,
    invite: invites.find((invite) => invite.room_id === room.room_id)?.code_masked ?? null,
  }))
}

const HEADERS = ['ROOM', 'PEOPLE', 'AGENTS', 'ASKS', 'KNOCKS', 'INVITE'] as const

/** A plain aligned table; room names are hub-validated slugs, so no free text reaches the terminal. */
export function roomTable(rooms: readonly RoomListing[]): readonly string[] {
  if (rooms.length === 0) return ['no rooms yet: agent-peers invite <room> --create']
  const rows = rooms.map((room) => [
    room.name,
    String(room.people),
    String(room.agents),
    String(room.open_asks),
    String(room.pending_knocks),
    room.invite ?? 'closed',
  ])
  const table = [[...HEADERS], ...rows]
  const widths = HEADERS.map((_, column) => Math.max(...table.map((row) => (row[column] ?? '').length)))
  return table.map((row) =>
    row
      .map((cell, column) => (column === row.length - 1 ? cell : cell.padEnd(widths[column] ?? 0)))
      .join('  '),
  )
}

export async function runRooms(
  options: RoomsOptions,
  io: CliIo,
  deps: AdminCommandDeps = {},
  globals: GlobalOptions = {},
): Promise<number> {
  try {
    const dataDir = adminDataDir(io, options.dataDir)
    const client = createAdminClient(await resolveAdminTarget(dataDir, options.adminUrl), deps)
    const rooms = await roomListing(client)
    io.stdout(globals.json ? `${JSON.stringify({ rooms })}\n` : `${roomTable(rooms).join('\n')}\n`)
    return 0
  } catch (error) {
    return renderError(io, error, globals)
  }
}

export function roomsCommand(
  io: CliIo,
  setExit: (code: number) => void,
  deps: AdminCommandDeps = {},
): Command {
  const command = new CommanderCommand('rooms').description("list the hub's rooms (run on the hub host)")
  return addAdminUrlOption(addDataDirOption(command)).action(async (options: RoomsOptions, self: Command) => {
    setExit(await runRooms(options, io, deps, globalsOf(self)))
  })
}
