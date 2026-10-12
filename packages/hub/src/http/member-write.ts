/**
 * Member API mutations (§9, §10): create a room, knock and decide, invite rotate/close/reopen,
 * restore, exit, session patches (which reach the bridge as `session.patched`), removals and
 * dissolve. Each maps one-to-one onto the service the WebSocket method uses.
 */
import {
  CreateRoomBodySchema,
  DecideBodySchema,
  KnockBodySchema,
  PatchSessionBodySchema,
  PeersError,
} from '@agent-peers/protocol'
import type { Context, Hono } from 'hono'
import { body, json, OK, param } from './errors'
import { memberActor } from './member-read'
import { IdParamSchema, InviteActionSchema, MemberRefSchema } from './schemas'
import type { AppEnv, HttpContext } from './types'

async function createRoom(ctx: HttpContext, c: Context<AppEnv>): Promise<Response> {
  const input = await body(c, CreateRoomBodySchema, 'invalid room')
  const { rooms, invites } = ctx.hub.services
  const created = rooms.create(memberActor(c), input)
  const invite = invites.view(created.room_id)
  if (!created.rendered || !invite) throw new PeersError('internal', 'the room was created without an invite')
  return json(
    {
      room: created.room,
      invite,
      invite_url: created.rendered.invite_url,
      join_prompt: created.rendered.join_prompt,
    },
    201,
  )
}

function inviteAction(ctx: HttpContext, c: Context<AppEnv>): Response {
  const roomId = param(c, 'id', IdParamSchema)
  const action = param(c, 'action', InviteActionSchema)
  const { invites } = ctx.hub.services
  const change = invites[action](memberActor(c), roomId)
  return json({
    invite: invites.view(roomId),
    invite_url: change.invite_url ?? null,
    join_prompt: change.join_prompt ?? null,
  })
}

async function patchSession(ctx: HttpContext, c: Context<AppEnv>): Promise<Response> {
  const sessionId = param(c, 'id', IdParamSchema)
  const patch = await body(c, PatchSessionBodySchema, 'invalid session patch')
  return json({ session: ctx.hub.services.rename.patch(memberActor(c), sessionId, patch) })
}

function mountRoomWrites(app: Hono<AppEnv>, ctx: HttpContext): void {
  const { membership, knocks } = ctx.hub.services
  const memberName = (c: Context<AppEnv>) => ctx.lookups.memberName(param(c, 'member', MemberRefSchema))

  app.post('/v0/me/rooms', (c) => createRoom(ctx, c))

  app.post('/v0/me/rooms/:id/knock', async (c) => {
    const input = await body(c, KnockBodySchema, 'invalid knock', true)
    return json({ knock: knocks.knock(memberActor(c), param(c, 'id', IdParamSchema), input.note) }, 201)
  })

  app.post('/v0/me/rooms/:id/invite/:action', (c) => inviteAction(ctx, c))

  app.post('/v0/me/rooms/:id/restore/:member', (c) => {
    membership.restore(memberActor(c), param(c, 'id', IdParamSchema), memberName(c))
    return json(OK)
  })

  app.post('/v0/me/rooms/:id/exit', (c) => {
    membership.exit(memberActor(c), param(c, 'id', IdParamSchema))
    return json(OK)
  })

  app.delete('/v0/me/rooms/:id/sessions/:sid', (c) => {
    membership.removeSession(memberActor(c), param(c, 'id', IdParamSchema), param(c, 'sid', IdParamSchema))
    return json(OK)
  })

  app.delete('/v0/me/rooms/:id/grants/:member', (c) => {
    membership.kick(memberActor(c), param(c, 'id', IdParamSchema), memberName(c))
    return json(OK)
  })

  app.delete('/v0/me/rooms/:id', (c) => {
    membership.dissolve(memberActor(c), param(c, 'id', IdParamSchema))
    return json(OK)
  })
}

function mountKnockWrites(app: Hono<AppEnv>, ctx: HttpContext): void {
  const { knocks } = ctx.hub.services

  app.post('/v0/me/knocks/:id/decide', async (c) => {
    const input = await body(c, DecideBodySchema, 'invalid decision')
    return json({ knock: knocks.decide(memberActor(c), param(c, 'id', IdParamSchema), input.decision) })
  })

  app.delete('/v0/me/knocks/:id', (c) => {
    knocks.withdraw(memberActor(c), param(c, 'id', IdParamSchema))
    return json(OK)
  })
}

export function mountMemberWrites(app: Hono<AppEnv>, ctx: HttpContext): void {
  mountRoomWrites(app, ctx)
  mountKnockWrites(app, ctx)
  app.patch('/v0/me/sessions/:id', (c) => patchSession(ctx, c))
}
