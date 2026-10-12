/**
 * Auto-join on session open (ONBOARDING §3 step 6, "After the finishing step"; PROTOCOL §4):
 * - `workspace` entries match the exact workspace realpath, `session` entries the local key;
 * - the bridge re-claims only its own remembered handle, never with a suffix and never with takeover;
 * - the open/reattach result is authoritative: a room the same session identity no longer holds was
 *   left while offline and is dropped from autojoin.json instead of being re-joined.
 */
import type { AutojoinEntry, LocalHome, SessionHandle } from '@agent-peers/core'
import { type AgentKind, isPeersError } from '@agent-peers/protocol'

/** A bootstrap session (`agent-peers join` without a session key) the bridge's session supersedes. */
export const BOOTSTRAP_PREFIX = 'bootstrap-'

const CODEX_KINDS: ReadonlySet<string> = new Set(['codex', 'codex-desktop'])

/** Same agent family: Codex CLI and desktop share threads and plugin trees. */
export function sameAgentFamily(entryAgent: AgentKind, agent: AgentKind): boolean {
  if (entryAgent === 'other' || entryAgent === agent) return true
  return CODEX_KINDS.has(entryAgent) && CODEX_KINDS.has(agent)
}

export interface AutojoinScope {
  readonly hub: string
  readonly agent: AgentKind
  readonly localKey: string
  readonly workspace: string | undefined
}

/** Entries for this hub, agent family and session (workspace realpath or local key). */
export async function autojoinEntries(
  home: LocalHome,
  scope: AutojoinScope,
): Promise<readonly AutojoinEntry[]> {
  const entries = await home.findAutojoin({
    ...(scope.workspace === undefined ? {} : { workspace: scope.workspace }),
    local_key: scope.localKey,
  })
  return entries.filter((e) => e.hub === scope.hub && sameAgentFamily(e.agent, scope.agent))
}

/** The bootstrap key to pass as `supersedes` on `session.open`, if a matching entry names one. */
export function supersedesFor(entries: readonly AutojoinEntry[], localKey: string): string | undefined {
  return entries.find((e) => e.local_key?.startsWith(BOOTSTRAP_PREFIX) && e.local_key !== localKey)?.local_key
}

export interface ApplyAutojoinInput extends AutojoinScope {
  readonly home: LocalHome
  readonly session: SessionHandle
  readonly entries: readonly AutojoinEntry[]
  /** Local keys whose open result is authoritative for an entry (this key, a superseded bootstrap). */
  readonly identityKeys: readonly string[]
  readonly log: (line: string) => void
}

export interface AutojoinOutcome {
  readonly joined: readonly string[]
  readonly dropped: readonly string[]
  readonly skipped: readonly string[]
}

const FATAL_JOIN_CODES = new Set(['forbidden', 'room_not_found', 'invite_invalid', 'invite_closed'])

async function forget(input: ApplyAutojoinInput, entry: AutojoinEntry): Promise<void> {
  await input.home.forgetAutojoin({ hub: entry.hub, room_id: entry.room_id, workspace: entry.workspace })
}

async function joinEntry(
  input: ApplyAutojoinInput,
  entry: AutojoinEntry,
): Promise<'joined' | 'dropped' | 'skipped'> {
  try {
    await input.session.join({ room_id: entry.room_id, handle: entry.handle })
    return 'joined'
  } catch (error) {
    if (isPeersError(error, 'handle_taken')) {
      input.log(`autojoin: @${entry.handle} is taken in room ${entry.room_id}; not joining (no suffix)`)
      return 'skipped'
    }
    if (isPeersError(error) && FATAL_JOIN_CODES.has(error.code)) {
      input.log(`autojoin: room ${entry.room_id} is gone (${error.code}); forgetting it`)
      await forget(input, entry)
      return 'dropped'
    }
    throw error
  }
}

/**
 * The first agent session superseded the `agent-peers join` bootstrap session and holds the room:
 * the entry now names that session, so later sessions in the workspace join (or find the handle
 * taken) instead of superseding the bootstrap key again and reading its empty result as "left".
 */
async function adoptBootstrapEntry(input: ApplyAutojoinInput, entry: AutojoinEntry): Promise<void> {
  if (!entry.local_key?.startsWith(BOOTSTRAP_PREFIX) || entry.local_key === input.localKey) return
  await input.home.rememberAutojoin({ ...entry, local_key: input.localKey })
}

/** Applies matching entries to a freshly opened session. Idempotent: rooms already held are skipped. */
export async function applyAutojoin(input: ApplyAutojoinInput): Promise<AutojoinOutcome> {
  const view = input.session.view
  const joinedIds = new Set(view.rooms.map((r) => r.room_id))
  const heldIds = new Set(view.heldRooms.map((r) => r.room_id))
  const outcome = { joined: [] as string[], dropped: [] as string[], skipped: [] as string[] }
  for (const entry of input.entries) {
    if (joinedIds.has(entry.room_id)) {
      await adoptBootstrapEntry(input, entry)
      continue
    }
    if (heldIds.has(entry.room_id)) {
      input.log(`autojoin: @${entry.handle} in room ${entry.room_id} is held by another live session`)
      outcome.skipped.push(entry.room_id)
      continue
    }
    if (entry.local_key !== undefined && input.identityKeys.includes(entry.local_key)) {
      input.log(`autojoin: room ${entry.room_id} was left while offline; forgetting it`)
      await forget(input, entry)
      outcome.dropped.push(entry.room_id)
      continue
    }
    const result = await joinEntry(input, entry)
    outcome[result].push(entry.room_id)
    if (result === 'joined') joinedIds.add(entry.room_id)
  }
  return outcome
}
