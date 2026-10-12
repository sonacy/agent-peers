/** Membership tools: peers_join, peers_create, peers_invite, peers_knock, peers_leave, peers_dashboard. */
import { basename } from 'node:path'
import { type AutojoinScope, AutojoinScopeSchema, defaultAutojoinScope } from '@agent-peers/core'
import {
  type DeepReadonly,
  isValidName,
  type MemberEntry,
  PeersError,
  toNameSlug,
} from '@agent-peers/protocol'
import { z } from 'zod'
import { parseInvite, redeemInvite } from '../hub/invite'
import type { Runtime } from '../runtime'
import type { BridgeSession } from '../session/bridge-session'
import { type BridgeTool, defineTool, ok, SessionKeyField, stripAt, type ToolContext } from './define'
import { resolveRoom } from './resolve'

const HandleArg = z.string().min(1).max(40).describe('Handle to claim, e.g. "work" (no @ needed).')
const RoomArg = z.string().min(1).max(64).describe('Room name.')

function handleOf(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined
  const handle = stripAt(raw)
  if (!isValidName(handle))
    throw new PeersError('invalid_name', `"${raw}" is not a valid handle (a-z, 0-9, - and _)`)
  return handle
}

const host = (origin: string | undefined): string => (origin ? new URL(origin).host : 'the hub')

/** Roster without free text (ONBOARDING §3 step 7): handle · agent · connection. */
function roster(members: readonly DeepReadonly<MemberEntry>[]): string {
  if (members.length === 0) return 'nobody else is here yet'
  return members.map((m) => `@${m.handle} (${m.card.agent.kind}, ${m.card.connection})`).join(', ')
}

/** Remembers the room for auto-join (ARCHITECTURE §3.1, ONBOARDING §3 step 6). */
async function remember(
  rt: Runtime,
  session: BridgeSession,
  room: { readonly room_id: string; readonly name: string; readonly handle: string },
  requested: AutojoinScope | undefined,
): Promise<string> {
  const hub = rt.connection.hub
  const workspace = session.workspace
  const fallback = workspace ? await defaultAutojoinScope(workspace, rt.userHome) : 'session'
  const scope = requested === 'workspace' && !workspace ? 'session' : (requested ?? fallback)
  if (scope === 'none' || hub === undefined) return ''
  await rt.home.rememberAutojoin({
    hub,
    room_id: room.room_id,
    handle: room.handle,
    agent: rt.descriptor.agentKind,
    workspace: workspace ?? `session:${session.localKey}`,
    local_key: session.localKey,
    scope,
  })
  return scope === 'workspace'
    ? `future sessions in ${workspace} will auto-join @${room.handle} in "${room.name}"`
    : `this session will re-join @${room.handle} in "${room.name}" when it resumes`
}

async function memberName(rt: Runtime, explicit: string | undefined, handle: string | undefined) {
  const config = await rt.config()
  const name = explicit ?? handle ?? config.handle
  if (name !== undefined) return name
  // ONBOARDING §3 step 4: never git user.name or $USER@host; the hub suffixes a taken name.
  const workspace = rt.registry.list()[0]?.workspace
  return workspace ? toNameSlug(basename(workspace), 'agent') : 'agent'
}

const JoinArgs = z.object({
  invite: z
    .string()
    .min(1)
    .max(2048)
    .describe('Invite link (https://<hub>/j/<code>), an invite code, or a room you already belong to.'),
  handle: HandleArg.optional(),
  member: z
    .string()
    .min(1)
    .max(32)
    .optional()
    .describe('Member name to register on a new hub (default: the handle).'),
  remember: AutojoinScopeSchema.optional().describe('Auto-join later: workspace, session or none.'),
  takeover: z.boolean().optional().describe('Only when the user explicitly asks to take the handle over.'),
  ...SessionKeyField,
})

async function join(ctx: ToolContext, args: z.output<typeof JoinArgs>) {
  const { rt } = ctx
  const ref = parseInvite(args.invite)
  const handle = handleOf(args.handle)
  let redeemedRoom: string | undefined
  let memberNote = ''
  if (ref.kind === 'url' && !(await rt.home.credentialFor(ref.hub))) {
    const name = await memberName(rt, args.member, handle)
    const redeemed = await redeemInvite(rt.fetch, ref.hub, ref.code, name, {
      insecure: rt.env.AGENT_PEERS_INSECURE === '1',
    })
    await rt.home.setCredential(ref.hub, {
      member_token: redeemed.member_token,
      member: redeemed.member.name,
    })
    redeemedRoom = redeemed.grant.room_id
    if (redeemed.renamed === true) memberNote = `\nyou are member ${redeemed.member.name} on this hub`
  }
  const session = await ctx.session(ref.kind === 'url' ? ref.hub : undefined)
  const target =
    redeemedRoom !== undefined
      ? { room_id: redeemedRoom }
      : ref.kind === 'room'
        ? { room_name: ref.room }
        : { invite_code: ref.code }
  const result = await session.handle.join({
    ...target,
    ...(handle ? { handle } : {}),
    ...(args.takeover === true ? { takeover: true } : {}),
  })
  session.roster.setRoomName(result.room.room_id, result.room.name)
  session.roster.setAll(result.members)
  const room = { room_id: result.room.room_id, name: result.room.name, handle: result.handle }
  const remembered = await remember(rt, session, room, args.remember)
  const others = result.members.filter((m) => m.card.session_id !== session.sessionId)
  return ok(
    `joined room "${room.name}" on ${host(rt.connection.hub)} as @${room.handle}${memberNote}\n` +
      `members: ${roster(others)}${remembered ? `\n${remembered}` : ''}`,
    room,
  )
}

const CreateArgs = z.object({
  name: z.string().min(1).max(64).describe('Room name, e.g. "payments-team".'),
  description: z.string().max(200).optional(),
  handle: HandleArg.optional(),
  remember: AutojoinScopeSchema.optional(),
  ...SessionKeyField,
})

async function create(ctx: ToolContext, args: z.output<typeof CreateArgs>) {
  const session = await ctx.session()
  const client = ctx.rt.connection.current?.client
  if (!client) throw new PeersError('not_connected', 'not connected to a hub')
  const name = isValidName(args.name) ? args.name : toNameSlug(args.name)
  const handle = handleOf(args.handle)
  const created = await client.request('room.create', {
    session_id: session.sessionId,
    name,
    ...(args.description ? { description: args.description } : {}),
    ...(handle ? { handle } : {}),
  })
  await session.handle.join({ room_id: created.room.room_id })
  const room = { room_id: created.room.room_id, name: created.room.name, handle: created.handle }
  const remembered = await remember(ctx.rt, session, room, args.remember)
  const share = created.join_prompt ?? created.invite_url
  return ok(
    `created room "${room.name}" on ${host(ctx.rt.connection.hub)}; you are its owner, as @${room.handle}.` +
      `${remembered ? `\n${remembered}` : ''}\n\nShare this join prompt with the people you want in it:\n\n${share}`,
    { ...room, invite_url: created.invite_url },
  )
}

const InviteArgs = z.object({
  room: RoomArg.optional(),
  new: z.boolean().optional().describe('Rotate: replace the invite code (the old one stops working).'),
  lang: z.enum(['en', 'zh']).optional(),
  ...SessionKeyField,
})

async function invite(ctx: ToolContext, args: z.output<typeof InviteArgs>) {
  const session = await ctx.session()
  const client = ctx.rt.connection.current?.client
  if (!client) throw new PeersError('not_connected', 'not connected to a hub')
  const room = resolveRoom(session, args.room)
  const params = { session_id: session.sessionId, room_id: room.room_id }
  const result =
    args.new === true
      ? await client.request('invite.rotate', params)
      : await client.request('invite.create', { ...params, ...(args.lang ? { lang: args.lang } : {}) })
  const share = result.join_prompt ?? result.invite_url ?? ''
  const verb = args.new === true ? 'New invite for' : 'Invite for'
  return ok(`${verb} "${room.name ?? room.room_id}" on ${host(ctx.rt.connection.hub)}:\n\n${share}`)
}

const KnockArgs = z.object({
  room: RoomArg,
  note: z.string().max(120).optional().describe('A short note to the owners.'),
  ...SessionKeyField,
})

async function knock(ctx: ToolContext, args: z.output<typeof KnockArgs>) {
  const session = await ctx.session()
  const name = args.room.trim().replace(/^#/, '')
  const { rooms } = await session.handle.search(name)
  const found = rooms.find((r) => r.name === name)
  if (!found) throw new PeersError('room_not_found', `no discoverable room "${name}"`)
  if (found.my_state === 'member') return ok(`you are already a member of "${name}": run peers_join ${name}`)
  const { knock_id } = await session.handle.knock(found.room_id, args.note)
  return ok(`knocked on "${name}" (owner @${found.owner}). Once an owner accepts, run peers_join ${name}.`, {
    knock_id,
    room_id: found.room_id,
  })
}

const LeaveArgs = z.object({ room: RoomArg.optional(), ...SessionKeyField })

async function leave(ctx: ToolContext, args: z.output<typeof LeaveArgs>) {
  const session = await ctx.session()
  const room = resolveRoom(session, args.room)
  await session.handle.leave(room.room_id)
  const hub = ctx.rt.connection.hub
  if (hub !== undefined) {
    const entries = await ctx.rt.home.readAutojoin()
    for (const e of entries.filter((x) => x.hub === hub && x.room_id === room.room_id))
      if (e.workspace === session.workspace || e.local_key === session.localKey)
        await ctx.rt.home.forgetAutojoin({ hub, room_id: room.room_id, workspace: e.workspace })
  }
  return ok(`left "${room.name ?? room.room_id}" and released @${room.handle}`)
}

async function dashboard(ctx: ToolContext) {
  const session = await ctx.session()
  const { url } = await session.handle.dashboardLogin()
  const opened = await ctx.rt.openUrl(url)
  return ok(
    `${opened ? 'Opened the dashboard in your browser.' : 'Open the dashboard:'} ${url}\n` +
      'This one-time link expires in 5 minutes. Give it only to the user; never paste it anywhere else.',
  )
}

export const roomTools: readonly BridgeTool[] = [
  defineTool({
    name: 'peers_join',
    description:
      'Join an agent-peers room: redeem an invite link (or code) if needed, join, and claim a handle. ' +
      'Run only when the user asks, and tell them the hub host first. Optionally remember it for auto-join.',
    schema: JoinArgs,
    annotations: { destructiveHint: false, openWorldHint: true },
    run: join,
  }),
  defineTool({
    name: 'peers_create',
    description:
      'Create a new room on the hub; you become its owner. Returns the join prompt to share verbatim.',
    schema: CreateArgs,
    annotations: { destructiveHint: false, openWorldHint: true },
    run: create,
  }),
  defineTool({
    name: 'peers_invite',
    description:
      "Room owners: show the room's join prompt, or rotate the invite with new=true. Show it verbatim.",
    schema: InviteArgs,
    annotations: { openWorldHint: true },
    run: invite,
  }),
  defineTool({
    name: 'peers_knock',
    description: 'Ask the owners of a discoverable room to let you in (no invite needed).',
    schema: KnockArgs,
    annotations: { openWorldHint: true },
    run: knock,
  }),
  defineTool({
    name: 'peers_leave',
    description: 'Leave a room and release your handle there (default: the only joined room).',
    schema: LeaveArgs,
    annotations: { destructiveHint: true },
    run: leave,
  }),
  defineTool({
    name: 'peers_dashboard',
    description: 'Open the agent-peers web dashboard with a one-time login link.',
    schema: z.object({ ...SessionKeyField }),
    annotations: { openWorldHint: true },
    run: dashboard,
  }),
]
