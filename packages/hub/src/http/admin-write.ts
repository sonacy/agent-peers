/**
 * Operator mutations on the admin listener (§9, DASHBOARD §10): settings, rooms and their invites,
 * handle renames, kicks, dissolve, invite and token revocation, and admin-token rotation.
 */
import { join } from 'node:path'
import type { Context, Hono } from 'hono'
import { ADMIN_TOKEN_FILE, writeSecret } from '../bootstrap'
import { isMemoryDataDir } from '../config'
import { ADMIN } from '../services/access'
import { startAdminSession } from './admin-auth'
import { settingsView } from './admin-read'
import { body, json, OK, param } from './errors'
import {
  AdminCreateRoomBodySchema,
  AdminInviteBodySchema,
  HandleParamSchema,
  IdParamSchema,
  MemberRefSchema,
  RenameHandleBodySchema,
  SettingsPatchSchema,
} from './schemas'
import type { AppEnv, HttpContext } from './types'

async function createRoom(ctx: HttpContext, c: Context<AppEnv>): Promise<Response> {
  const input = await body(c, AdminCreateRoomBodySchema, 'invalid room')
  const created = ctx.hub.services.rooms.create(ADMIN, input)
  return json(
    {
      room: created.room,
      invite: ctx.hub.services.invites.view(created.room_id),
      invite_url: created.rendered?.invite_url ?? null,
      join_prompt: created.rendered?.join_prompt ?? null,
    },
    201,
  )
}

async function createInvite(ctx: HttpContext, c: Context<AppEnv>): Promise<Response> {
  const input = await body(c, AdminInviteBodySchema, 'invalid invite options', true)
  const rendered = ctx.hub.services.invites.createFor(ADMIN, param(c, 'id', IdParamSchema), {
    ...(input.lang !== undefined ? { lang: input.lang } : {}),
    ...(input.suggested_handle !== undefined ? { suggestedHandle: input.suggested_handle } : {}),
  })
  return json(
    {
      invite_url: rendered.invite_url,
      join_prompt: rendered.join_prompt,
      join_command: rendered.join_command,
      expires_at: rendered.expires_at,
    },
    201,
  )
}

/** Replaces the admin token, persists it (0600) on a disk-backed hub and signs other browsers out. */
async function rotateAdminToken(ctx: HttpContext, c: Context<AppEnv>): Promise<Response> {
  const token = ctx.hub.services.auth.rotateAdmin()
  const { dataDir, logger } = ctx.config
  let persisted = false
  if (!isMemoryDataDir(dataDir)) {
    try {
      await writeSecret(join(dataDir, ADMIN_TOKEN_FILE), token)
      persisted = true
    } catch (error) {
      logger.error('could not write the rotated admin token', error)
    }
  }
  ctx.adminSessions.clear()
  startAdminSession(ctx, c)
  return c.json({ admin_token: token, persisted }, 200, { 'cache-control': 'no-store' })
}

function mountRoomWrites(app: Hono<AppEnv>, ctx: HttpContext): void {
  const { membership, rename } = ctx.hub.services
  app.post('/v0/admin/rooms', (c) => createRoom(ctx, c))
  app.post('/v0/admin/rooms/:id/invites', (c) => createInvite(ctx, c))
  app.patch('/v0/admin/rooms/:id/handles/:handle', async (c) => {
    const input = await body(c, RenameHandleBodySchema, 'invalid rename')
    const roomId = param(c, 'id', IdParamSchema)
    return json(rename.renameHandle(ADMIN, roomId, param(c, 'handle', HandleParamSchema), input.handle))
  })
  app.delete('/v0/admin/rooms/:id/grants/:member', (c) => {
    const member = ctx.lookups.memberName(param(c, 'member', MemberRefSchema))
    membership.kick(ADMIN, param(c, 'id', IdParamSchema), member)
    return json(OK)
  })
  app.delete('/v0/admin/rooms/:id', (c) => {
    membership.dissolve(ADMIN, param(c, 'id', IdParamSchema))
    return json(OK)
  })
}

export function mountAdminWrites(app: Hono<AppEnv>, ctx: HttpContext): void {
  const { invites, members } = ctx.hub.services
  app.patch('/v0/admin/settings', async (c) => {
    ctx.settings.update(await body(c, SettingsPatchSchema, 'invalid settings'))
    return json(settingsView(ctx))
  })
  mountRoomWrites(app, ctx)
  app.delete('/v0/admin/invites/:id', (c) => {
    invites.close(ADMIN, ctx.lookups.activeInviteRoom(param(c, 'id', IdParamSchema)))
    return json(OK)
  })
  app.delete('/v0/admin/members/:id/tokens', (c) => {
    const memberId = param(c, 'id', IdParamSchema)
    ctx.lookups.requireMember(memberId)
    return json({ revoked: members.revokeTokens(memberId) })
  })
  app.post('/v0/admin/rotate-admin-token', (c) => rotateAdminToken(ctx, c))
}
