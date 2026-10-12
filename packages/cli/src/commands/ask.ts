/**
 * `agent-peers ask @handle[@room] <question…> [--wait s] [--write]`: sends an ask; with `--wait`,
 * waits for the reply and prints it inside the untrusted-input envelope (PROTOCOL §7.2).
 */
import type { SessionRoom } from '@agent-peers/core'
import { type DeepReadonly, isTerminalAskState, type Message, PeersError } from '@agent-peers/protocol'
import { type Command, InvalidArgumentError } from 'commander'
import { EXIT } from '../errors'
import type { CliIo } from '../io'
import { memberLine, messageEnvelope, parseTarget } from '../join/render'
import { ensureRooms, roomName, type ShellContext, type ShellOptions } from '../join/shell'
import {
  type Emit,
  type Print,
  runShell,
  shellCommand,
  shellOptions,
  usageFailure,
} from '../join/shell-command'
import type { PeersDeps } from '../join/types'

export interface AskOptions extends ShellOptions {
  /** Seconds to wait for the reply (0: don't wait). */
  readonly wait?: number
  readonly write?: boolean
}

const MAX_WAIT_S = 600

function parseWait(value: string): number {
  const seconds = Number(value)
  if (!Number.isFinite(seconds) || seconds < 0 || seconds > MAX_WAIT_S)
    throw new InvalidArgumentError(`expected 0–${MAX_WAIT_S} seconds`)
  return seconds
}

/** The room holding `@handle`: the named one, else the only joined room where the handle exists. */
async function targetRoom(ctx: ShellContext, handle: string, room: string | undefined): Promise<SessionRoom> {
  const rooms = await ensureRooms(ctx, room)
  if (room !== undefined && rooms[0]) return rooms[0]
  const holding: SessionRoom[] = []
  for (const joined of rooms) {
    const { members } = await ctx.hub.session.peers(joined.room_id)
    if (members.some((member) => member.handle === handle)) holding.push(joined)
  }
  const [only, ...rest] = holding
  if (only === undefined) throw new PeersError('target_not_found', `nobody is @${handle} in your rooms`)
  if (rest.length > 0)
    throw new PeersError(
      'invalid_params',
      `@${handle} is in several rooms: use ${holding.map((r) => `@${handle}@${roomName(r)}`).join(' or ')}`,
    )
  return only
}

type Outcome = { readonly reply: DeepReadonly<Message> } | { readonly state: string } | undefined

/**
 * Watches for the reply to an ask. It listens before the ask is sent, so a reply that arrives
 * before `msg.send` returns is not missed; `wait` resolves with the reply, a terminal state without
 * one, or undefined at the deadline.
 */
function watchReplies(ctx: ShellContext) {
  const byAsk = new Map<string, Outcome>()
  let wanted: string | undefined
  let notify: (() => void) | undefined
  const record = (askId: string, outcome: Outcome) => {
    if (!byAsk.has(askId)) byAsk.set(askId, outcome)
    if (askId === wanted) notify?.()
  }
  const offs = [
    ctx.hub.session.on('msg.new', ({ message }) => {
      if (message.kind === 'reply' && message.re) record(message.re, { reply: message })
    }),
    ctx.hub.session.on('ask.updated', (update) => {
      if (update.state !== 'answered' && isTerminalAskState(update.state))
        record(update.ask_id, { state: `${update.state}${update.reason ? ` (${update.reason})` : ''}` })
    }),
  ]
  const stop = () => {
    for (const off of offs) off()
  }
  const wait = (askId: string, waitMs: number): Promise<Outcome> =>
    new Promise((resolve) => {
      wanted = askId
      const finish = () => {
        clearTimeout(timer)
        stop()
        resolve(byAsk.get(askId))
      }
      const timer = setTimeout(finish, waitMs)
      notify = finish
      if (byAsk.has(askId)) finish()
    })
  return { wait, stop }
}

async function report(
  ctx: ShellContext,
  room: SessionRoom,
  handle: string,
  text: string,
  outcome: Outcome,
  print: Print,
  emit: Emit,
  sent: Readonly<Record<string, unknown>>,
) {
  if (outcome === undefined) {
    const { members } = await ctx.hub.session.peers(room.room_id)
    const target = members.find((m) => m.handle === handle)
    print(
      `pending · ${target ? memberLine(target, room.handle) : `@${handle}`}: the reply will arrive later (agent-peers inbox)`,
    )
    emit({ ...sent, outcome: 'pending' })
    return EXIT.ok
  }
  if ('reply' in outcome) {
    print(messageEnvelope(outcome.reply, roomName(room), text))
    emit({ ...sent, outcome: 'answered', reply: outcome.reply })
    return EXIT.ok
  }
  print(`ask ${outcome.state}`)
  emit({ ...sent, outcome: outcome.state })
  return EXIT.failure
}

export async function runAsk(
  target: string,
  words: readonly string[],
  options: AskOptions,
  io: CliIo,
  deps: PeersDeps = {},
): Promise<number> {
  const parsed = parseTarget(target)
  const text = words.join(' ').trim()
  if (!parsed || !text) return usageFailure(io, options, 'usage: agent-peers ask @handle[@room] <question>')
  return runShell(io, deps, options, async (ctx, print, emit) => {
    const room = await targetRoom(ctx, parsed.handle, parsed.room)
    const waitMs = (options.wait ?? 0) * 1000
    const watcher = watchReplies(ctx)
    try {
      const sent = await ctx.hub.session.ask({
        room_id: room.room_id,
        to: parsed.handle,
        text,
        mode: options.write ? 'write' : 'read',
      })
      const state = sent.ask?.state ?? 'queued'
      print(`ask ${sent.id} to @${parsed.handle} in #${roomName(room)}: ${state}`)
      const summary = {
        ask_id: sent.id,
        to: parsed.handle,
        room: roomName(room),
        room_id: room.room_id,
        state,
      }
      emit(summary)
      if (waitMs <= 0) return EXIT.ok
      const outcome = await watcher.wait(sent.id, waitMs)
      return await report(ctx, room, parsed.handle, text, outcome, print, emit, summary)
    } finally {
      watcher.stop()
    }
  })
}

export function askCommand(io: CliIo, setExit: (code: number) => void, deps: PeersDeps = {}): Command {
  return shellCommand('ask', 'ask a peer a question (@handle or @handle@room)')
    .argument('<target>', '@handle or @handle@room')
    .argument('<question...>', 'the question')
    .option('--wait <seconds>', 'wait this long for the reply', parseWait)
    .option('--write', 'label the ask as a write request (a label, not a permission)')
    .action(async (target: string, words: string[], options: AskOptions, self: Command) => {
      const wait = options.wait === undefined ? {} : { wait: options.wait }
      setExit(
        await runAsk(
          target,
          words,
          { ...shellOptions(options, self), ...wait, write: options.write === true },
          io,
          deps,
        ),
      )
    })
}
