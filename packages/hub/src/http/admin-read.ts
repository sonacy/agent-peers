/**
 * Operator reads on the admin listener (§9, DASHBOARD §10): status, settings, rooms, room detail and
 * messages, sessions, members, invites and the unfiltered event stream.
 */
import { MESSAGE_RETENTION_MS } from '@agent-peers/protocol'
import type { Context, Hono } from 'hono'
import { ADMIN } from '../services/access'
import { adminCredential } from './admin-auth'
import { json, param, parseWith } from './errors'
import { HistoryQuerySchema, IdParamSchema } from './schemas'
import { eventFrame, sseResponse } from './sse'
import type { AppEnv, HttpContext } from './types'

function status(ctx: HttpContext) {
  const now = ctx.config.clock.now()
  return {
    version: ctx.config.version,
    public_url: ctx.settings.publicUrl() ?? null,
    registration: ctx.settings.registration(),
    started_at: ctx.startedAt,
    uptime_ms: Math.max(0, now - ctx.startedAt),
    connections: ctx.hub.registry.connectionCount,
    sessions_attached: ctx.hub.registry.sessionCount,
    ...ctx.lookups.counts(),
  }
}

export function settingsView(ctx: HttpContext) {
  const { config } = ctx
  return {
    public_url: ctx.settings.publicUrl() ?? null,
    registration: ctx.settings.registration(),
    allow_room_creation: config.allowRoomCreation,
    retention_ms: MESSAGE_RETENTION_MS,
    messages_per_minute: config.messagesPerMinute,
    rate_limits: ctx.options.rateLimits,
    heartbeat_ms: config.heartbeatMs,
    grace_ms: config.graceMs,
    public_bind: config.publicBind,
    admin_bind: config.adminBind,
    version: config.version,
  }
}

function events(ctx: HttpContext, c: Context<AppEnv>): Response {
  const alive = adminCredential(ctx, c) ?? (() => false)
  c.env.server.timeout(c.req.raw, 0)
  let id = 0
  return sseResponse({
    clock: ctx.config.clock,
    keepaliveMs: ctx.options.sseKeepaliveMs,
    registry: ctx.streams,
    alive,
    subscribe: (write) => ctx.hub.services.events.on((event) => write(eventFrame(event, ++id))),
  })
}

export function mountAdminReads(app: Hono<AppEnv>, ctx: HttpContext): void {
  const { services } = ctx.hub
  app.get('/v0/admin/status', () => json(status(ctx)))
  app.get('/v0/admin/settings', () => json(settingsView(ctx)))
  app.get('/v0/admin/rooms', () => json({ rooms: ctx.lookups.rooms() }))
  app.get('/v0/admin/rooms/:id', (c) =>
    json(services.queries.roomDetail(ADMIN, param(c, 'id', IdParamSchema))),
  )
  app.get('/v0/admin/rooms/:id/messages', (c) => {
    const query = parseWith(HistoryQuerySchema, c.req.query(), 'invalid messages query')
    const roomId = param(c, 'id', IdParamSchema)
    const page = services.messages.history(undefined, { room_id: roomId, ...query })
    return json({ messages: page.messages, ...(page.truncated ? { truncated: true } : {}) })
  })
  app.get('/v0/admin/sessions', () => json({ sessions: ctx.lookups.sessions() }))
  app.get('/v0/admin/members', () => json({ members: ctx.lookups.members() }))
  app.get('/v0/admin/invites', () => json({ invites: ctx.lookups.invites() }))
  app.get('/v0/admin/events', (c) => events(ctx, c))
}
