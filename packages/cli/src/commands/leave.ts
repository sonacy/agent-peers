/** `agent-peers leave [room]`: leaves the room, releases the handle and forgets it in autojoin.json. */
import type { Command } from 'commander'
import type { CliIo } from '../io'
import { roomName, type ShellOptions, singleRoom } from '../join/shell'
import { runShell, shellCommand, shellOptions } from '../join/shell-command'
import type { PeersDeps } from '../join/types'

export async function runLeave(
  room: string | undefined,
  options: ShellOptions,
  io: CliIo,
  deps: PeersDeps = {},
): Promise<number> {
  return runShell(io, deps, options, async (ctx, print, emit) => {
    const joined = await singleRoom(ctx, room)
    await ctx.hub.session.leave(joined.room_id)
    const entries = await ctx.local.readAutojoin()
    const forgotten = entries.filter(
      (e) => e.hub === ctx.origin && e.room_id === joined.room_id && e.handle === joined.handle,
    )
    for (const entry of forgotten)
      await ctx.local.forgetAutojoin({ hub: entry.hub, room_id: entry.room_id, workspace: entry.workspace })
    print(
      `left #${roomName(joined)}: @${joined.handle} is released${forgotten.length ? ' and no longer auto-joined' : ''}`,
    )
    emit({
      room: roomName(joined),
      room_id: joined.room_id,
      handle: joined.handle,
      forgotten: forgotten.length > 0,
    })
    return undefined
  })
}

export function leaveCommand(io: CliIo, setExit: (code: number) => void, deps: PeersDeps = {}): Command {
  return shellCommand('leave', 'leave a room and release your handle')
    .argument('[room]', 'the room (needed when you are in several)')
    .action(async (room: string | undefined, options: ShellOptions, self: Command) => {
      setExit(await runLeave(room, shellOptions(options, self), io, deps))
    })
}
