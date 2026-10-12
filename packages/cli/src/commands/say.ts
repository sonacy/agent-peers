/** `agent-peers say <text…> [--room r]`: room chat. It goes to inboxes and never starts a turn. */
import type { Command } from 'commander'
import type { CliIo } from '../io'
import { roomName, type ShellOptions, singleRoom } from '../join/shell'
import { runShell, shellCommand, shellOptions, usageFailure } from '../join/shell-command'
import type { PeersDeps } from '../join/types'

export interface RoomOption extends ShellOptions {
  readonly room?: string
}

export async function runSay(
  words: readonly string[],
  options: RoomOption,
  io: CliIo,
  deps: PeersDeps = {},
): Promise<number> {
  const text = words.join(' ').trim()
  if (!text) return usageFailure(io, options, 'usage: agent-peers say <text>')
  return runShell(io, deps, options, async (ctx, print, emit) => {
    const room = await singleRoom(ctx, options.room)
    const sent = await ctx.hub.session.send({ room_id: room.room_id, text })
    print(`said in #${roomName(room)} as @${room.handle} (message ${sent.id})`)
    emit({ room: roomName(room), room_id: room.room_id, handle: room.handle, message_id: sent.id })
    return undefined
  })
}

export function sayCommand(io: CliIo, setExit: (code: number) => void, deps: PeersDeps = {}): Command {
  return shellCommand('say', 'send a chat message to a room (never starts a turn)')
    .argument('<text...>', 'the message')
    .option('--room <room>', 'the room (needed when you are in several)')
    .action(async (words: string[], options: RoomOption, self: Command) => {
      const room = options.room ? { room: options.room } : {}
      setExit(await runSay(words, { ...shellOptions(options, self), ...room }, io, deps))
    })
}
