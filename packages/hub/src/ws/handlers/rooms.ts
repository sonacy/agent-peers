/** `room.*`, `knock.*`, `invite.*` and `peers.list` (§2.1, §6.4, §10). */
import { EMPTY, type HandlerContext, type HandlerTable, reply, sessionActor } from './types'

const deliverAfter = (ctx: HandlerContext, sessionId: string, roomId: string, handle: string) => () =>
  ctx.services.messages.deliverRoom(sessionId, roomId, handle)

export const roomHandlers: HandlerTable = {
  'room.join': (ctx, params) => {
    const joined = ctx.services.rooms.join(params.session_id, params)
    return reply(joined, deliverAfter(ctx, params.session_id, joined.room.room_id, joined.handle))
  },

  'room.create': (ctx, params) => {
    const { session_id, ...input } = params
    const created = ctx.services.rooms.create(sessionActor(ctx, session_id), input)
    const handle = created.handle ?? ''
    return reply(
      {
        room: created.room,
        handle,
        invite_url: created.rendered?.invite_url ?? '',
        ...(created.rendered ? { join_prompt: created.rendered.join_prompt } : {}),
      },
      deliverAfter(ctx, session_id, created.room_id, handle),
    )
  },

  'room.leave': (ctx, params) => {
    ctx.services.rooms.leave(params.session_id, params.room_id)
    return EMPTY
  },

  'room.list': (ctx, params) => reply({ rooms: ctx.services.rooms.list(params.session_id) }),

  'peers.list': (ctx, params) =>
    reply({ members: ctx.services.rooms.peers(params.session_id, params.room_id) }),

  'room.search': (ctx, params) => reply({ rooms: ctx.services.rooms.search(ctx.conn.memberId, params.q) }),

  'room.knock': (ctx, params) => {
    const knock = ctx.services.knocks.knock(sessionActor(ctx, params.session_id), params.room_id, params.note)
    return reply({ knock_id: knock.knock_id })
  },

  'knock.withdraw': (ctx, params) => {
    ctx.services.knocks.withdraw(sessionActor(ctx, params.session_id), params.knock_id)
    return EMPTY
  },

  'knock.decide': (ctx, params) => {
    ctx.services.knocks.decide(sessionActor(ctx, params.session_id), params.knock_id, params.decision)
    return EMPTY
  },

  'room.remove_session': (ctx, params) => {
    ctx.services.membership.removeSession(
      sessionActor(ctx, params.session_id),
      params.room_id,
      params.target_session_id,
    )
    return EMPTY
  },

  'room.exit': (ctx, params) => {
    ctx.services.membership.exit(sessionActor(ctx, params.session_id), params.room_id)
    return EMPTY
  },

  'room.dissolve': (ctx, params) => {
    ctx.services.membership.dissolve(sessionActor(ctx, params.session_id), params.room_id)
    return EMPTY
  },

  'room.kick': (ctx, params) => {
    ctx.services.membership.kick(sessionActor(ctx, params.session_id), params.room_id, params.member)
    return EMPTY
  },

  'invite.rotate': (ctx, params) =>
    reply(ctx.services.invites.rotate(sessionActor(ctx, params.session_id), params.room_id)),
  'invite.close': (ctx, params) =>
    reply(ctx.services.invites.close(sessionActor(ctx, params.session_id), params.room_id)),
  'invite.reopen': (ctx, params) =>
    reply(ctx.services.invites.reopen(sessionActor(ctx, params.session_id), params.room_id)),

  'invite.create': (ctx, params) => {
    const rendered = ctx.services.invites.createFor(sessionActor(ctx, params.session_id), params.room_id, {
      ...(params.lang !== undefined ? { lang: params.lang } : {}),
      ...(params.suggested_handle !== undefined ? { suggestedHandle: params.suggested_handle } : {}),
    })
    return reply({
      invite_url: rendered.invite_url,
      expires_at: rendered.expires_at,
      join_prompt: rendered.join_prompt,
      join_command: rendered.join_command,
    })
  },
}
