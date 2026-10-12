/**
 * Step 1 of `join` (ONBOARDING §3): no side effects. Shows the hub origin (registrable domain
 * emphasised, IDNs as punycode), the room and inviter (sanitized hub strings), the member name that
 * will be registered and the card fields that will be published.
 */
import type { AutojoinEntry, Credential, LocalConfig } from '@agent-peers/core'
import { type AgentKind, type CardInput, sanitizePromptValue } from '@agent-peers/protocol'
import type { WorkspaceFields } from './card'
import { workspaceSlug } from './card'
import type { InvitePreview } from './hub-http'
import type { HandleChoice } from './membership'
import { describeOrigin, emphasiseOrigin } from './origin'

/** `"Payments Team" (#payments-team)`: the display name sanitized like a join prompt value. */
export function roomLabel(preview: InvitePreview): string {
  const display = preview.room.display_name ? sanitizePromptValue(preview.room.display_name) : ''
  return display && display !== preview.room.name ? display : preview.room.name
}

/** `--handle`, else the handle remembered for this room and workspace, else config, else the slug. */
export function chooseHandle(
  explicit: string | undefined,
  remembered: AutojoinEntry | undefined,
  config: LocalConfig,
  workspace: string,
): HandleChoice {
  if (explicit) return { name: explicit, fixed: true }
  if (remembered) return { name: remembered.handle, fixed: true }
  if (config.handle) return { name: config.handle, fixed: true }
  return { name: workspaceSlug(workspace), fixed: false }
}

export interface PreviewView {
  readonly origin: string
  readonly preview: InvitePreview
  readonly credential: Credential | undefined
  readonly memberName: string
  readonly handle: HandleChoice
  readonly kind: AgentKind
  readonly card: CardInput
  readonly workspace: WorkspaceFields | undefined
}

function cardLine(view: PreviewView): string {
  const ws = view.workspace
  const fields = [
    `handle @${view.handle.name}${view.handle.fixed ? '' : ' (or a free variant)'}`,
    `member ${view.memberName}`,
    `agent ${view.kind}`,
    `model ${view.card.model ?? '(none)'}`,
    `workspace ${ws?.name ?? '(not shared)'}`,
    ...(ws?.git_remote ? [`remote ${ws.git_remote}`] : []),
    ...(ws?.branch ? [`branch ${ws.branch}`] : []),
    ...(view.card.summary ? [`summary "${view.card.summary}"`] : []),
  ]
  return fields.join(' · ')
}

export function previewLines(view: PreviewView): readonly string[] {
  const origin = describeOrigin(view.origin)
  const notes = [
    ...(origin.punycode ? ['internationalised domain shown as punycode'] : []),
    ...(origin.local ? ['a local/private address'] : []),
  ]
  const member = view.credential
    ? `${view.credential.member ?? '(unnamed)'} (already a member of this hub)`
    : `${view.memberName} (new member on this hub)`
  return [
    `room "${roomLabel(view.preview)}" (#${view.preview.room.name}), invited by @${sanitizePromptValue(view.preview.inviter)}`,
    `  hub:      ${emphasiseOrigin(origin)}  <- registrable domain ${origin.registrable.toUpperCase()}${
      notes.length ? ` (${notes.join(', ')})` : ''
    }`,
    `  member:   ${member}`,
    `  publish:  ${cardLine(view)}`,
  ]
}
