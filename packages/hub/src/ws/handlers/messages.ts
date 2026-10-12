/** `msg.*` and `ask.*` (§6). */
import { EMPTY, type HandlerTable, reply, sessionActor } from './types'

export const messageHandlers: HandlerTable = {
  'msg.send': (ctx, params) => reply(ctx.services.sending.send(params.session_id, params)),
  'msg.reply': (ctx, params) => reply(ctx.services.sending.reply(params.session_id, params)),
  'msg.progress': (ctx, params) => reply(ctx.services.sending.progress(params.session_id, params)),
  'ask.claim': (ctx, params) => reply({ ask: ctx.services.asks.claim(params.session_id, params.ask_id) }),

  'ask.cancel': (ctx, params) => {
    ctx.services.asks.cancel(sessionActor(ctx, params.session_id), params.ask_id)
    return EMPTY
  },

  'ask.get': (ctx, params) =>
    reply(ctx.services.asks.get(sessionActor(ctx, params.session_id), params.ask_id)),

  'msg.ack': (ctx, params) => {
    ctx.services.messages.ack(params.session_id, params)
    return EMPTY
  },

  'msg.history': (ctx, params) => {
    const page = ctx.services.messages.history(ctx.conn.memberId, params)
    return reply({ messages: page.messages, ...(page.truncated ? { truncated: true } : {}) })
  },
}
