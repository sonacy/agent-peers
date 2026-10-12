/** `agent-peers knock <room> [note…]` (PROTOCOL §10.2): ask the owner of a discoverable room to let you in. */
import { PeersError, sanitizeLine } from '@agent-peers/protocol'
import type { Command } from 'commander'
import { EXIT } from '../errors'
import type { CliIo } from '../io'
import type { ShellOptions } from '../join/shell'
import { runShell, shellCommand, shellOptions } from '../join/shell-command'
import type { PeersDeps } from '../join/types'

export async function runKnock(
  room: string,
  words: readonly string[],
  options: ShellOptions,
  io: CliIo,
  deps: PeersDeps = {},
): Promise<number> {
  const name = room.trim().replace(/^#/, '').toLowerCase()
  const note = sanitizeLine(words.join(' '), 120)
  return runShell(io, deps, options, async (ctx, print, emit) => {
    const { rooms } = await ctx.hub.session.search(name)
    const found = rooms.find((r) => r.name === name)
    if (!found) throw new PeersError('room_not_found', `no discoverable room named ${name}`)
    if (found.my_state === 'member') {
      print(`you are already a member of #${name}: agent-peers who ${name}`)
      emit({ room: name, room_id: found.room_id, member: true })
      return EXIT.ok
    }
    const { knock_id } = await ctx.hub.session.knock(found.room_id, note || undefined)
    print(`knocked on #${name} (knock ${knock_id}); the owner @${found.owner} decides`)
    emit({ room: name, room_id: found.room_id, knock_id, owner: found.owner })
    return undefined
  })
}

export function knockCommand(io: CliIo, setExit: (code: number) => void, deps: PeersDeps = {}): Command {
  return shellCommand('knock', 'ask to join a discoverable room you have no invite for')
    .argument('<room>', 'the room name')
    .argument('[note...]', 'a short note for the owner')
    .action(async (room: string, words: string[], options: ShellOptions, self: Command) => {
      setExit(await runKnock(room, words, shellOptions(options, self), io, deps))
    })
}
