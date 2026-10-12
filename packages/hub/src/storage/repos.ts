/** All repositories over one database. */
import type { Database } from 'bun:sqlite'
import { createAdminRepo } from './repos/admin'
import { createAsksRepo } from './repos/asks'
import { createAuditRepo } from './repos/audit'
import { createCursorsRepo } from './repos/cursors'
import { createGrantsRepo } from './repos/grants'
import { createHandlesRepo } from './repos/handles'
import { createIdempotencyRepo } from './repos/idempotency'
import { createInvitesRepo } from './repos/invites'
import { createKnocksRepo } from './repos/knocks'
import { createLoginCodesRepo } from './repos/login-codes'
import { createMemberTokensRepo } from './repos/member-tokens'
import { createMembersRepo } from './repos/members'
import { createMessagesRepo } from './repos/messages'
import { createRoomsRepo } from './repos/rooms'
import { createSessionRoomsRepo } from './repos/session-rooms'
import { createSessionsRepo } from './repos/sessions'
import { createWebSessionsRepo } from './repos/web-sessions'

export function createRepos(db: Database) {
  return Object.freeze({
    members: createMembersRepo(db),
    memberTokens: createMemberTokensRepo(db),
    webSessions: createWebSessionsRepo(db),
    loginCodes: createLoginCodesRepo(db),
    admin: createAdminRepo(db),
    rooms: createRoomsRepo(db),
    grants: createGrantsRepo(db),
    invites: createInvitesRepo(db),
    knocks: createKnocksRepo(db),
    sessions: createSessionsRepo(db),
    sessionRooms: createSessionRoomsRepo(db),
    handles: createHandlesRepo(db),
    messages: createMessagesRepo(db),
    asks: createAsksRepo(db),
    cursors: createCursorsRepo(db),
    idempotency: createIdempotencyRepo(db),
    audit: createAuditRepo(db),
  })
}
export type Repos = ReturnType<typeof createRepos>
