/**
 * Step 6 of `join` (ONBOARDING §3): one autojoin.json entry per (hub origin, room, workspace
 * realpath). `workspace` scope matches the exact realpath only; `$HOME`, `/` and directories outside
 * a git repository default to `session` scope.
 */
import { type AutojoinScope, defaultAutojoinScope, type LocalHome } from '@agent-peers/core'
import type { AgentKind } from '@agent-peers/protocol'

export interface RememberInput {
  readonly origin: string
  readonly roomId: string
  readonly roomLabel: string
  readonly handle: string
  readonly agent: AgentKind
  /** Realpath of the working directory. */
  readonly workspace: string
  /** The bootstrap session that holds the handle now (the bridge supersedes or revives it). */
  readonly localKey: string
  readonly requested?: AutojoinScope
  readonly userHome: string
}

export interface Remembered {
  readonly scope: AutojoinScope
  readonly line: string
}

export async function rememberStep(local: LocalHome, input: RememberInput): Promise<Remembered> {
  const scope = input.requested ?? (await defaultAutojoinScope(input.workspace, input.userHome))
  const where = `@${input.handle} in "${input.roomLabel}"`
  if (scope === 'none')
    return { scope, line: `not remembered (--remember none): use /peers:join to re-join ${where}` }
  await local.rememberAutojoin({
    hub: input.origin,
    room_id: input.roomId,
    handle: input.handle,
    agent: input.agent,
    workspace: input.workspace,
    local_key: input.localKey,
    scope,
  })
  const line =
    scope === 'workspace'
      ? `future sessions in ${input.workspace} will auto-join ${where}`
      : `this agent session will auto-join ${where} (session scope: ${input.workspace} is not a project workspace)`
  return { scope, line }
}

/** Handles this machine remembers for a room on a hub (any workspace). */
export async function rememberedHandles(
  local: LocalHome,
  origin: string,
  roomId: string,
): Promise<readonly string[]> {
  const entries = await local.readAutojoin()
  return entries.filter((e) => e.hub === origin && e.room_id === roomId).map((e) => e.handle)
}
