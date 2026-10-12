/** `agent-peers who [room]`: every member of your rooms (handle · agent · model · connection · activity · tier). */
import type { Command } from 'commander'
import type { CliIo } from '../io'
import { memberLine } from '../join/render'
import { ensureRooms, roomName, type ShellOptions } from '../join/shell'
import { runShell, shellCommand, shellOptions } from '../join/shell-command'
import type { PeersDeps } from '../join/types'

export async function runWho(
  room: string | undefined,
  options: ShellOptions,
  io: CliIo,
  deps: PeersDeps = {},
): Promise<number> {
  return runShell(io, deps, options, async (ctx, print, emit) => {
    const rooms = []
    for (const joined of await ensureRooms(ctx, room)) {
      const { members } = await ctx.hub.session.peers(joined.room_id)
      print(
        `#${roomName(joined)} · you are @${joined.handle}`,
        ...members.map((member) => `  ${memberLine(member, joined.handle)}`),
      )
      rooms.push({ room: roomName(joined), room_id: joined.room_id, handle: joined.handle, members })
    }
    emit({ rooms })
    return undefined
  })
}

export function whoCommand(io: CliIo, setExit: (code: number) => void, deps: PeersDeps = {}): Command {
  return shellCommand('who', 'list the members of your rooms')
    .argument('[room]', 'only this room')
    .action(async (room: string | undefined, options: ShellOptions, self: Command) => {
      setExit(await runWho(room, shellOptions(options, self), io, deps))
    })
}
