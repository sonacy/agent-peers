/** Wires every service over one set of dependencies. */
import { createAccess } from './access'
import { createAsks } from './asks'
import { createAuth } from './auth'
import { createCards } from './cards'
import { createClaims } from './claims'
import type { ServiceDeps } from './context'
import { createInvites } from './invites'
import { createKnocks } from './knocks'
import { createMembers } from './members'
import { createMembership } from './membership'
import { createMessages } from './messages'
import { createPresence } from './presence'
import { createQueries } from './queries'
import { createRateLimiter } from './rate-limit'
import { createRename } from './rename'
import { createRooms } from './rooms'
import { createSending } from './sending'
import { createSessions } from './sessions'
import { createSweeper } from './sweeper'

const MINUTE = 60_000

export function createServices(deps: ServiceDeps) {
  const access = createAccess(deps)
  const cards = createCards(deps)
  const asks = createAsks(deps, access)
  const messages = createMessages(deps, access, asks)
  const limiter = createRateLimiter(deps.clock, deps.config.messagesPerMinute, MINUTE)
  const sending = createSending(deps, access, asks, messages, limiter)
  const presence = createPresence(deps, access, cards, asks)
  const claims = createClaims(deps, access, asks, messages, presence)
  const invites = createInvites(deps, access)
  const sessions = createSessions(deps, access, cards, claims, presence)
  const rename = createRename(deps, access, cards, messages, presence)
  const rooms = createRooms(deps, access, cards, claims, invites, messages, presence)
  const membership = createMembership(deps, access, claims, asks, invites)
  const knocks = createKnocks(deps, access)
  const members = createMembers(deps, access, invites, presence)
  const auth = createAuth(deps, access)
  const queries = createQueries(deps, access, cards, invites, knocks, membership)
  const sweeper = createSweeper(deps, asks, knocks, presence)
  return Object.freeze({
    deps,
    access,
    cards,
    asks,
    messages,
    sending,
    limiter,
    presence,
    claims,
    invites,
    sessions,
    rename,
    rooms,
    membership,
    knocks,
    members,
    auth,
    queries,
    sweeper,
    events: deps.events,
  })
}
export type Services = ReturnType<typeof createServices>
