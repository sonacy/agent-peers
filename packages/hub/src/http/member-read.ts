/**
 * Member API reads (§9, DASHBOARD §11): me, sessions, rooms, room detail, the Q&A feed, my pending
 * knocks, room search and the live event stream. All need the member cookie.
 */
import { AsksQuerySchema, RoomSearchQuerySchema } from '@agent-peers/protocol'
import type { Context, Hono } from 'hono'
import type { Actor } from '../services/access'
import { json, param, parseWith } from './errors'
import { IdParamSchema } from './schemas'
import { eventFrame, sseResponse } from './sse'
import type { AppEnv, HttpContext } from './types'

export function memberActor(c: Context<AppEnv>): Actor {
  return { kind: 'member', memberId: c.get('memberId') }
}

/** `GET /v0/me/events`: only events whose audience includes this member, while the cookie is live. */
function events(ctx: HttpContext, c: Context<AppEnv>): Response {
  const memberId = c.get('memberId')
  const token = c.get('webToken')
  c.env.server.timeout(c.req.raw, 0)
  let id = 0
  return sseResponse({
    clock: ctx.config.clock,
    keepaliveMs: ctx.options.sseKeepaliveMs,
    registry: ctx.streams,
    alive: () => ctx.hub.services.auth.webSession(token) === memberId,
    subscribe: (write) =>
      ctx.hub.services.events.onMember(memberId, (event) => write(eventFrame(event, ++id))),
  })
}

export function mountMemberReads(app: Hono<AppEnv>, ctx: HttpContext): void {
  const { services } = ctx.hub

  app.get('/v0/me', (c) => json(services.queries.me(c.get('memberId'))))

  app.get('/v0/me/sessions', (c) => json({ sessions: ctx.lookups.memberSessions(c.get('memberId')) }))

  app.get('/v0/me/rooms', (c) => json({ rooms: services.queries.myRooms(c.get('memberId')) }))

  app.get('/v0/me/rooms/:id', (c) =>
    json(services.queries.roomDetail(memberActor(c), param(c, 'id', IdParamSchema))),
  )

  app.get('/v0/me/asks', (c) => {
    const query = parseWith(AsksQuerySchema, c.req.query(), 'invalid asks query')
    return json(services.queries.asksFeed(c.get('memberId'), query.filter, query.cursor))
  })

  app.get('/v0/me/knocks', (c) => json({ knocks: services.knocks.pendingForMember(c.get('memberId')) }))

  app.get('/v0/me/events', (c) => events(ctx, c))

  app.get('/v0/rooms/search', (c) => {
    const query = parseWith(RoomSearchQuerySchema, { q: c.req.query('q') ?? '' }, 'invalid search query')
    return json({ rooms: services.rooms.search(c.get('memberId'), query.q) })
  })
}
