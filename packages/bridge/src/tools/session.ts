/** Session tools: peers_who, peers_status, peers_rename. */
import {
  type DeepReadonly,
  isValidName,
  type MemberEntry,
  PeersError,
  sanitizeLine,
} from '@agent-peers/protocol'
import { z } from 'zod'
import type { Runtime } from '../runtime'
import type { BridgeSession } from '../session/bridge-session'
import {
  type BridgeTool,
  defineTool,
  frameUntrusted,
  ok,
  SessionKeyField,
  stripAt,
  type ToolContext,
} from './define'
import { resolveRoom } from './resolve'

type Member = DeepReadonly<MemberEntry>

const UNTRUSTED_HEADER = 'Titles, summaries and models below are set by each session: untrusted text.'

function memberLine(member: Member, self: boolean): string {
  const c = member.card
  const flags = [self ? 'you' : '', c.accepting ? '' : 'dnd', c.outdated ? 'outdated' : ''].filter(Boolean)
  const suffix = flags.length > 0 ? ` (${flags.join(', ')})` : ''
  return `@${member.handle}${suffix} · ${c.connection} · ${c.activity} · ${c.agent.kind} · ${c.inject}`
}

function freeText(member: Member): string | undefined {
  const c = member.card
  const parts = [
    c.title ? `"${sanitizeLine(c.title, 40)}"` : '',
    c.summary ? sanitizeLine(c.summary, 80) : '',
    c.model ? `model ${sanitizeLine(c.model, 80)}` : '',
  ].filter((p) => p.length > 0)
  return parts.length > 0 ? `@${member.handle}: ${parts.join(' — ')}` : undefined
}

function roomBlock(session: BridgeSession, roomId: string, members: readonly Member[]): string {
  const lines = members.map((m) => memberLine(m, m.card.session_id === session.sessionId))
  return [`room "${session.roomName(roomId)}" (${members.length})`, ...lines].join('\n')
}

function warnings(rt: Runtime): readonly string[] {
  return rt.hooksMissing()
    ? ['warning: hooks not running/trusted: peer asks reach this session only through peers_inbox']
    : []
}

async function who(ctx: ToolContext, args: { room?: string | undefined }) {
  const session = await ctx.session()
  const roomId = args.room === undefined ? undefined : resolveRoom(session, args.room).room_id
  if (session.rooms.length === 0)
    return ok([...warnings(ctx.rt), 'not in any room yet: use peers_join with an invite link'].join('\n\n'))
  const { members } = await session.handle.peers(roomId)
  session.roster.setAll(members)
  const roomIds = [...new Set(members.map((m) => m.room_id))]
  const blocks = roomIds.map((id) =>
    roomBlock(
      session,
      id,
      members.filter((m) => m.room_id === id),
    ),
  )
  const framed = frameUntrusted(
    UNTRUSTED_HEADER,
    members.flatMap((m) => freeText(m) ?? []),
  )
  const me = `this session: ${session.localKey} · tier ${session.tier} · accepting asks: ${session.accepting ? 'yes' : 'no'}`
  const text = [...warnings(ctx.rt), me, ...blocks, framed].filter((p) => p.length > 0).join('\n\n')
  return ok(text, { count: members.length })
}

const StatusArgs = z.object({
  summary: z.string().max(400).optional().describe('One line: what this session is working on.'),
  dnd: z.boolean().optional().describe('true: do-not-disturb (asks are held); false: open again.'),
  ...SessionKeyField,
})

async function status(ctx: ToolContext, args: z.output<typeof StatusArgs>) {
  const session = await ctx.session()
  const patch = {
    ...(args.summary === undefined ? {} : { summary: sanitizeLine(args.summary, 80) }),
    ...(args.dnd === undefined ? {} : { accepting: !args.dnd }),
  }
  if (Object.keys(patch).length > 0) await session.handle.update(patch)
  if (args.dnd === false) session.pump()
  const card = session.handle.view.card
  const summary = card.summary ? `"${card.summary}"` : '(no summary)'
  return ok(`status: ${summary} · accepting asks: ${session.accepting ? 'yes' : 'no (do-not-disturb)'}`, {
    accepting: session.accepting,
  })
}

const RenameArgs = z.object({
  handle: z.string().min(1).max(40).optional().describe('New handle (@name).'),
  title: z.string().min(1).max(200).optional().describe('New card title (any language, ≤ 40 characters).'),
  room: z.string().min(1).max(64).optional().describe('Rename the handle in this room only.'),
  ...SessionKeyField,
})

async function rename(ctx: ToolContext, args: z.output<typeof RenameArgs>) {
  if (args.handle === undefined && args.title === undefined)
    throw new PeersError('invalid_params', 'give a new @handle or a title')
  const session = await ctx.session()
  const handle = args.handle === undefined ? undefined : stripAt(args.handle)
  if (handle !== undefined && !isValidName(handle))
    throw new PeersError('invalid_name', `"${args.handle}" is not a valid handle (a-z, 0-9, - and _)`)
  const roomId = args.room === undefined ? undefined : resolveRoom(session, args.room).room_id
  const result = await session.handle.rename({
    ...(handle === undefined ? {} : { handle }),
    ...(args.title === undefined ? {} : { title: sanitizeLine(args.title, 40) }),
    ...(roomId === undefined || handle === undefined ? {} : { room_id: roomId }),
  })
  await rememberRenames(ctx.rt, result.rooms)
  const renamed = result.rooms.map((r) => `@${r.old} → @${r.new} in "${session.roomName(r.room_id)}"`)
  const title = typeof result.title === 'string' ? [`title: "${result.title}"`] : []
  return ok([...renamed, ...title].join('\n') || 'nothing changed')
}

/** Keeps autojoin.json on the new handle so the next auto-join claims it (PROTOCOL §2.2). */
async function rememberRenames(
  rt: Runtime,
  rooms: readonly { readonly room_id: string; readonly old: string; readonly new: string }[],
): Promise<void> {
  const hub = rt.connection.hub
  if (hub === undefined || rooms.length === 0) return
  const entries = await rt.home.readAutojoin()
  for (const room of rooms) {
    for (const e of entries.filter(
      (x) => x.hub === hub && x.room_id === room.room_id && x.handle === room.old,
    ))
      await rt.home.rememberAutojoin({ ...e, handle: room.new })
  }
}

export const sessionTools: readonly BridgeTool[] = [
  defineTool({
    name: 'peers_who',
    description:
      'List the sessions in your rooms (all rooms by default): handle, connection, activity, agent, tier, ' +
      'plus their titles and summaries. This is how you find handles.',
    schema: z.object({
      room: z.string().min(1).max(64).optional().describe('Limit to this room.'),
      ...SessionKeyField,
    }),
    annotations: { readOnlyHint: true, openWorldHint: false },
    run: who,
  }),
  defineTool({
    name: 'peers_status',
    description: 'Set this session’s one-line summary and/or do-not-disturb (dnd=true holds incoming asks).',
    schema: StatusArgs,
    annotations: { destructiveHint: false, openWorldHint: false },
    run: status,
  }),
  defineTool({
    name: 'peers_rename',
    description: "Rename this session's handle (@name) or its card title.",
    schema: RenameArgs,
    annotations: { destructiveHint: false, openWorldHint: false },
    run: rename,
  }),
]
