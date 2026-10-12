/**
 * `agent-peers inbox [--room r] [--peek]`: unread messages and asks of your rooms, each inside the
 * untrusted-input envelope (PROTOCOL §7.2); then marks them read (`msg.ack`) unless `--peek`.
 */
import type { Command } from 'commander'
import type { CliIo } from '../io'
import { messageEnvelope } from '../join/render'
import { ensureRooms, roomName } from '../join/shell'
import { runShell, shellCommand, shellOptions } from '../join/shell-command'
import type { PeersDeps } from '../join/types'
import type { RoomOption } from './say'

export interface InboxOptions extends RoomOption {
  readonly peek?: boolean
}

/** At most this many unread messages per room are printed; older ones stay in `msg.history`. */
export const INBOX_LIMIT = 50

export async function runInbox(options: InboxOptions, io: CliIo, deps: PeersDeps = {}): Promise<number> {
  return runShell(io, deps, options, async (ctx, print, emit) => {
    const rooms = await ensureRooms(ctx, options.room)
    const { rooms: listed } = await ctx.hub.session.list()
    const unreadRooms = []
    let total = 0
    for (const room of rooms) {
      const unread = listed.find((entry) => entry.room_id === room.room_id)?.unread ?? 0
      if (unread <= 0) continue
      const { messages } = await ctx.hub.session.history(room.room_id, {
        limit: Math.min(unread, INBOX_LIMIT),
      })
      const fresh = messages.filter((m) => m.from?.handle !== room.handle)
      print(`#${roomName(room)}: ${unread} unread`, ...fresh.map((m) => messageEnvelope(m, roomName(room))))
      total += unread
      unreadRooms.push({ room: roomName(room), room_id: room.room_id, unread, messages: fresh })
      const last = messages.at(-1)
      if (!options.peek && last) await ctx.hub.session.ack(room.room_id, last.seq)
    }
    if (total === 0) print('inbox empty')
    emit({ unread: total, rooms: unreadRooms })
    return undefined
  })
}

export function inboxCommand(io: CliIo, setExit: (code: number) => void, deps: PeersDeps = {}): Command {
  return shellCommand('inbox', 'show unread messages and asks, then mark them read')
    .option('--room <room>', 'only this room')
    .option('--peek', 'do not mark them read')
    .action(async (options: InboxOptions, self: Command) => {
      const extra = { ...(options.room ? { room: options.room } : {}), peek: options.peek === true }
      setExit(await runInbox({ ...shellOptions(options, self), ...extra }, io, deps))
    })
}
