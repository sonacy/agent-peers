/**
 * `agent-peers rename [title…] [--handle h] [--room r]` (PROTOCOL §2.2): the session's title, or its
 * handle in one room (every joined room without `--room`). autojoin.json follows a handle rename.
 */
import type { LocalHome, SessionRoom } from '@agent-peers/core'
import { isValidName, PeersError, type ResultOf } from '@agent-peers/protocol'
import type { Command } from 'commander'
import type { CliIo } from '../io'
import { stripAt } from '../join/context'
import { ensureRooms, roomName, type ShellOptions } from '../join/shell'
import { runShell, shellCommand, shellOptions, usageFailure } from '../join/shell-command'
import type { PeersDeps } from '../join/types'

export interface RenameOptions extends ShellOptions {
  readonly handle?: string
  readonly room?: string
}

/** Keeps autojoin.json on the new handle so the next auto-join claims it (PROTOCOL §2.2). */
async function followRename(local: LocalHome, origin: string, renamed: ResultOf<'session.rename'>['rooms']) {
  const entries = await local.readAutojoin()
  for (const change of renamed) {
    for (const entry of entries.filter(
      (e) => e.hub === origin && e.room_id === change.room_id && e.handle === change.old,
    ))
      await local.rememberAutojoin({ ...entry, handle: change.new })
  }
}

function roomIdFor(rooms: readonly SessionRoom[], name: string | undefined): string | undefined {
  if (name === undefined) return undefined
  const found = rooms.find((room) => room.name === name)
  if (!found) throw new PeersError('room_not_found', `you are not in a room named ${name}`)
  return found.room_id
}

export async function runRename(
  words: readonly string[],
  options: RenameOptions,
  io: CliIo,
  deps: PeersDeps = {},
): Promise<number> {
  const title = words.join(' ').trim()
  const handle = options.handle === undefined ? undefined : stripAt(options.handle)
  if ((!title && handle === undefined) || (handle !== undefined && !isValidName(handle)))
    return usageFailure(io, options, 'usage: agent-peers rename <title> | --handle <handle> [--room <room>]')
  return runShell(io, deps, options, async (ctx, print, emit) => {
    const rooms = await ensureRooms(ctx, options.room)
    const roomId = handle === undefined ? undefined : roomIdFor(rooms, options.room)
    const result = await ctx.hub.session.rename({
      ...(title ? { title } : {}),
      ...(handle ? { handle } : {}),
      ...(roomId ? { room_id: roomId } : {}),
    })
    await followRename(ctx.local, ctx.origin, result.rooms)
    const named = (id: string) =>
      roomName(rooms.find((room) => room.room_id === id) ?? { room_id: id, handle: '' })
    print(
      ...(typeof result.title === 'string' && title ? [`title: ${result.title}`] : []),
      ...result.rooms.map((change) => `@${change.old} is now @${change.new} in #${named(change.room_id)}`),
    )
    emit({ ...(typeof result.title === 'string' ? { title: result.title } : {}), rooms: result.rooms })
    return undefined
  })
}

export function renameCommand(io: CliIo, setExit: (code: number) => void, deps: PeersDeps = {}): Command {
  return shellCommand('rename', "rename this session's title, or its handle with --handle")
    .argument('[title...]', 'the new title (at most 40 characters)')
    .option('--handle <handle>', 'the new handle')
    .option('--room <room>', 'rename the handle in this room only')
    .action(async (words: string[], options: RenameOptions, self: Command) => {
      const extra = {
        ...(options.handle ? { handle: options.handle } : {}),
        ...(options.room ? { room: options.room } : {}),
      }
      setExit(await runRename(words, { ...shellOptions(options, self), ...extra }, io, deps))
    })
}
