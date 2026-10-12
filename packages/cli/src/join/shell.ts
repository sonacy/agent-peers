/**
 * The shell fallback (ONBOARDING §4 "Before the finishing step", ARCHITECTURE §3.1): `who`, `ask`,
 * `say`, … run as the CURRENT agent session when the CLI runs inside an agent (its session key from
 * the environment), or as this machine's CLI session otherwise, over a short-lived hub connection
 * with the member token from credentials.json.
 */
import { realpath } from 'node:fs/promises'
import { resolve } from 'node:path'
import { type Credentials, hubOrigin, type LocalConfig, LocalHome, type SessionRoom } from '@agent-peers/core'
import { type AgentKind, isPeersError, PeersError } from '@agent-peers/protocol'
import { detectCurrentAgent } from '../agents/current'
import { determineFor, homeFor, sysFor } from '../commands/installer-deps'
import type { CliIo } from '../io'
import { ADAPTER_VERSION, buildCard, readGitInfo, shortHost, workspaceFields } from './card'
import { type HubSession, openHubSession } from './hub-session'
import type { PeersDeps } from './types'

export interface ShellOptions {
  readonly hub?: string
  readonly sessionKey?: string
  readonly insecure?: boolean
  /** The global `--json`: one JSON document on stdout instead of human lines. */
  readonly json?: boolean
}

export interface ShellContext {
  readonly local: LocalHome
  readonly config: LocalConfig
  readonly origin: string
  readonly hub: HubSession
  readonly kind: AgentKind
  readonly localKey: string
  /** True when acting as an agent's own session (not the machine's CLI session). */
  readonly asAgent: boolean
}

/** The CLI's own session key when no agent session is known: one per machine. */
export const cliLocalKey = (host: string): string => `cli-${host}`

/** `--hub`, else `default_hub`, else the only hub with a token. */
export function pickHub(credentials: Credentials, config: LocalConfig, explicit: string | undefined): string {
  const origins = Object.keys(credentials.hubs)
  if (explicit !== undefined) {
    const origin = hubOrigin(explicit)
    if (!origins.includes(origin))
      throw new PeersError('unauthorized', `no member token for ${origin}: join a room there first`)
    return origin
  }
  const preferred = config.default_hub ? hubOrigin(config.default_hub) : undefined
  if (preferred && origins.includes(preferred)) return preferred
  const [only, ...rest] = origins
  if (only === undefined)
    throw new PeersError('unauthorized', 'not a member of any hub yet: run agent-peers join <invite link>')
  if (rest.length > 0)
    throw new PeersError(
      'invalid_params',
      `you are a member of several hubs (${origins.join(', ')}): pass --hub`,
    )
  return only
}

interface Identity {
  readonly kind: AgentKind
  readonly localKey: string
  readonly asAgent: boolean
}

async function identity(io: CliIo, deps: PeersDeps, options: ShellOptions, host: string): Promise<Identity> {
  const current = await detectCurrentAgent(io.env, determineFor(io, deps))
  const kind: AgentKind = current?.id ?? 'other'
  const key =
    options.sessionKey ?? current?.sessionKey ?? (current?.name === 'pi' ? io.env.PI_SESSION_ID : undefined)
  if (key) return { kind, localKey: key, asAgent: true }
  return { kind: 'other', localKey: cliLocalKey(host), asAgent: false }
}

/** Opens the acting session and runs `work`; the session is closed and the socket said bye to. */
export async function withShellSession<T>(
  io: CliIo,
  deps: PeersDeps,
  options: ShellOptions,
  work: (ctx: ShellContext) => Promise<T>,
): Promise<T> {
  const sys = sysFor(io, deps)
  const local = new LocalHome({ root: homeFor(io, sys), userHome: sys.home })
  const config = await local.readConfig()
  const origin = pickHub(await local.readCredentials(), config, options.hub)
  const credential = await local.credentialFor(origin)
  const host = shortHost(deps.hostname)
  const who = await identity(io, deps, options, host)
  const cwd = deps.cwd ?? process.cwd()
  const workspace = await realpath(cwd).catch(() => resolve(cwd))
  const fields = workspaceFields(config.workspace.share, workspace, await readGitInfo(workspace))
  const hub = await openHubSession({
    origin,
    token: credential?.member_token ?? '',
    kind: who.kind,
    adapter: ADAPTER_VERSION,
    host,
    localKey: who.localKey,
    card: buildCard({
      kind: who.kind,
      host,
      adapter: ADAPTER_VERSION,
      ...(fields ? { workspace: fields } : {}),
    }),
    ...(options.insecure ? { insecure: true } : {}),
    ...(deps.webSocketFactory ? { webSocketFactory: deps.webSocketFactory } : {}),
    ...(deps.requestTimeoutMs ? { requestTimeoutMs: deps.requestTimeoutMs } : {}),
  })
  try {
    return await work({
      local,
      config,
      origin,
      hub,
      kind: who.kind,
      localKey: who.localKey,
      asAgent: who.asAgent,
    })
  } finally {
    await hub.close(true)
  }
}

async function joinRemembered(
  ctx: ShellContext,
  target: { readonly room_id: string } | { readonly room_name: string },
  handle: string | undefined,
): Promise<SessionRoom> {
  const session = ctx.hub.session
  try {
    const joined = await session.join({ ...target, ...(handle ? { handle } : {}) })
    return { room_id: joined.room.room_id, handle: joined.handle, name: joined.room.name }
  } catch (error) {
    if (!handle || !isPeersError(error, 'handle_taken')) throw error
    const joined = await session.join(target)
    return { room_id: joined.room.room_id, handle: joined.handle, name: joined.room.name }
  }
}

/** Rooms remembered for this hub in autojoin.json (one per room, the entry's handle). */
async function rememberedRooms(ctx: ShellContext) {
  const entries = (await ctx.local.readAutojoin()).filter((e) => e.hub === ctx.origin)
  return [...new Map(entries.map((e) => [e.room_id, e])).values()]
}

/**
 * The rooms this session acts in. A named room it is not in yet is joined by name; with no room
 * named and none joined, the rooms remembered in autojoin.json are joined with their handles.
 */
export async function ensureRooms(ctx: ShellContext, roomName?: string): Promise<readonly SessionRoom[]> {
  const joined = ctx.hub.session.view.rooms
  if (roomName === undefined) return joined.length > 0 ? joined : joinRememberedRooms(ctx)
  const found = joined.find((room) => room.name === roomName)
  if (found) return [found]
  // A remembered room that is gone is reported by the direct join by name below instead.
  const remembered = (await joinRememberedRooms(ctx).catch(() => [])).find((room) => room.name === roomName)
  return [remembered ?? (await joinRemembered(ctx, { room_name: roomName }, ctx.config.handle))]
}

/** Joins every room remembered for this hub with its remembered handle. */
async function joinRememberedRooms(ctx: ShellContext): Promise<readonly SessionRoom[]> {
  const rooms: SessionRoom[] = []
  const failures: PeersError[] = []
  for (const entry of await rememberedRooms(ctx)) {
    try {
      rooms.push(await joinRemembered(ctx, { room_id: entry.room_id }, entry.handle))
    } catch (error) {
      if (!isPeersError(error)) throw error
      failures.push(error)
    }
  }
  if (rooms.length > 0) return rooms
  throw (
    failures[0] ?? new PeersError('room_not_found', 'not in any room yet: run agent-peers join <invite link>')
  )
}

/** Exactly one room: the named one, or the only one this session is in. */
export async function singleRoom(ctx: ShellContext, roomName?: string): Promise<SessionRoom> {
  const rooms = await ensureRooms(ctx, roomName)
  const [only, ...rest] = rooms
  if (only === undefined) throw new PeersError('room_not_found', 'not in any room')
  if (rest.length > 0)
    throw new PeersError(
      'invalid_params',
      `you are in several rooms (${rooms.map((r) => r.name ?? r.room_id).join(', ')}): pass --room`,
    )
  return only
}

export const roomName = (room: SessionRoom): string => room.name ?? room.room_id
