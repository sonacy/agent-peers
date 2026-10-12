/** `ping`, `session.*` and `dashboard.login` (§4, §2.2, §6.4). */
import { EMPTY, type HandlerTable, reply, sessionActor } from './types'

export const sessionHandlers: HandlerTable = {
  ping: (ctx) => reply({ server_time: ctx.services.deps.now() }),

  'session.open': (ctx, params) => {
    const { services, conn, registry } = ctx
    const opened = services.sessions.open({ memberId: conn.memberId, outdated: conn.outdated }, params)
    registry.attach(conn, opened.session_id)
    const joined = opened.rooms.flatMap((r) => (r.status === 'joined' ? [r] : []))
    return reply(opened, () => {
      for (const room of joined) services.messages.deliverRoom(opened.session_id, room.room_id, room.handle)
    })
  },

  'session.close': (ctx, params) => {
    ctx.services.sessions.close(params.session_id)
    return EMPTY
  },

  'session.update': (ctx, params) => {
    const { session_id, ...patch } = params
    ctx.services.sessions.update(session_id, patch)
    return EMPTY
  },

  'session.rename': (ctx, params) => {
    const { session_id, ...input } = params
    return reply(ctx.services.rename.rename(sessionActor(ctx, session_id), session_id, input))
  },

  'dashboard.login': (ctx, params) => {
    const link = ctx.services.auth.createLogin(params.session_id)
    return reply({ code: link.code, url: link.url })
  },
}
