/**
 * Pure helpers over autojoin.json entries (ONBOARDING §3 step 6, ARCHITECTURE §8): one entry per
 * (hub origin, room, workspace realpath); `workspace` scope matches the exact realpath only,
 * `session` scope matches the local key only, `none` never matches.
 */
import { stat } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import type { AgentKind } from '@agent-peers/protocol'
import { type AutojoinEntry, type AutojoinScope, hubOrigin } from './schemas'

export const autojoinKey = (entry: Pick<AutojoinEntry, 'hub' | 'room_id' | 'workspace'>): string =>
  `${hubOrigin(entry.hub)}\u0000${entry.room_id}\u0000${entry.workspace}`

/** Returns a new list with `entry` replacing any entry with the same (hub, room, workspace) key. */
export function upsertAutojoin(
  entries: readonly AutojoinEntry[],
  entry: AutojoinEntry,
): readonly AutojoinEntry[] {
  const normalized = { ...entry, hub: hubOrigin(entry.hub) }
  const key = autojoinKey(normalized)
  return [...entries.filter((e) => autojoinKey(e) !== key), normalized]
}

/** Removes entries for a room on a hub; with `workspace`, only that workspace's entry. */
export function removeAutojoin(
  entries: readonly AutojoinEntry[],
  target: { readonly hub: string; readonly room_id: string; readonly workspace?: string },
): readonly AutojoinEntry[] {
  const hub = hubOrigin(target.hub)
  return entries.filter(
    (e) =>
      !(
        e.hub === hub &&
        e.room_id === target.room_id &&
        (target.workspace === undefined || e.workspace === target.workspace)
      ),
  )
}

export interface AutojoinQuery {
  /** Realpath of the session's workspace. */
  readonly workspace?: string
  readonly local_key?: string
  readonly agent?: AgentKind
}

export function matchesAutojoin(entry: AutojoinEntry, query: AutojoinQuery): boolean {
  if (query.agent !== undefined && entry.agent !== query.agent && entry.agent !== 'other') return false
  switch (entry.scope) {
    case 'workspace':
      return query.workspace !== undefined && entry.workspace === query.workspace
    case 'session':
      return query.local_key !== undefined && entry.local_key === query.local_key
    default:
      return false
  }
}

export function matchAutojoin(
  entries: readonly AutojoinEntry[],
  query: AutojoinQuery,
): readonly AutojoinEntry[] {
  return entries.filter((entry) => matchesAutojoin(entry, query))
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

/** True when `dir` or one of its parents contains `.git` (a directory or a worktree file). */
export async function isInsideGitRepo(dir: string): Promise<boolean> {
  let current = resolve(dir)
  for (;;) {
    if (await exists(join(current, '.git'))) return true
    const parent = dirname(current)
    if (parent === current) return false
    current = parent
  }
}

/** ONBOARDING §3 step 6: `$HOME`, `/` or a directory outside any git repo default to `session` scope. */
export async function defaultAutojoinScope(workspace: string, userHome: string): Promise<AutojoinScope> {
  const path = resolve(workspace)
  if (path === resolve(userHome) || path === '/') return 'session'
  return (await isInsideGitRepo(path)) ? 'workspace' : 'session'
}
