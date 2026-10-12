/**
 * The card the bootstrap session publishes (PROTOCOL §3), built like the bridge builds it so the
 * bridge's later `session.open` matches the same identity (member, host, agent kind, local key).
 * Workspace fields follow `workspace.share`; absolute paths never leave the machine.
 */
import { hostname as osHostname } from 'node:os'
import { basename, join } from 'node:path'
import type { WorkspaceShare } from '@agent-peers/core'
import { type AgentKind, type CardInput, isValidName, sanitizeLine, toNameSlug } from '@agent-peers/protocol'

/** The adapter version advertised in `hello` and on cards (matches the bridge's). */
export { ADAPTER_VERSION } from '@agent-peers/bridge'

/** Short, single-line host name (`gulei-mbp.local` → `gulei-mbp`), as the bridge computes it. */
export function shortHost(name: string = osHostname()): string {
  const short = sanitizeLine(name.split('.')[0] ?? '', 64)
  return short.length > 0 ? short : 'host'
}

export interface GitInfo {
  readonly branch?: string
  readonly remote?: string
}

/** `git@github.com:acme/api.git` / `https://user:tok@github.com/acme/api.git` → `github.com/acme/api`. */
export function normalizeRemote(url: string): string | undefined {
  const trimmed = url.trim().replace(/\.git$/, '')
  const scp = /^[\w.-]+@([\w.-]+):(.+)$/.exec(trimmed)
  if (scp) return `${scp[1]}/${scp[2]}`
  try {
    const parsed = new URL(trimmed)
    if (parsed.protocol === 'file:' || parsed.hostname === '') return undefined
    return `${parsed.hostname}${parsed.pathname}`.replace(/\/+$/, '')
  } catch {
    return undefined
  }
}

async function readText(path: string): Promise<string | undefined> {
  const file = Bun.file(path)
  return (await file.exists()) ? file.text() : undefined
}

/** Branch and `origin` remote straight from `.git` (no git process). */
export async function readGitInfo(workspace: string): Promise<GitInfo> {
  const head = await readText(join(workspace, '.git', 'HEAD')).catch(() => undefined)
  const config = await readText(join(workspace, '.git', 'config')).catch(() => undefined)
  const branch = /^ref: refs\/heads\/(.+)$/m.exec(head ?? '')?.[1]?.trim()
  const section = /\[remote "origin"\]([^[]*)/.exec(config ?? '')?.[1] ?? ''
  const url = /^\s*url\s*=\s*(.+)$/m.exec(section)?.[1]
  const remote = url ? normalizeRemote(url) : undefined
  return { ...(branch ? { branch: sanitizeLine(branch, 80) } : {}), ...(remote ? { remote } : {}) }
}

export interface WorkspaceFields {
  readonly name?: string
  readonly git_remote?: string
  readonly branch?: string
}

export function workspaceFields(
  share: WorkspaceShare,
  workspace: string,
  git: GitInfo,
): WorkspaceFields | undefined {
  if (share === 'none') return undefined
  const name = sanitizeLine(basename(workspace), 80)
  if (share === 'name') return name ? { name } : undefined
  return {
    ...(name ? { name } : {}),
    ...(git.remote ? { git_remote: git.remote } : {}),
    ...(git.branch ? { branch: git.branch } : {}),
  }
}

export interface CardSpec {
  readonly kind: AgentKind
  readonly host: string
  readonly agentVersion?: string
  readonly adapter: string
  readonly workspace?: WorkspaceFields
  readonly model?: string
  readonly summary?: string
}

export function buildCard(spec: CardSpec): CardInput {
  const title = spec.workspace?.name
  return {
    agent: {
      kind: spec.kind,
      adapter: spec.adapter,
      ...(spec.agentVersion ? { version: spec.agentVersion.slice(0, 64) } : {}),
    },
    host: spec.host,
    activity: 'unknown',
    ...(spec.model ? { model: sanitizeLine(spec.model, 80) } : {}),
    ...(spec.workspace ? { workspace: spec.workspace } : {}),
    ...(title ? { title: title.slice(0, 40) } : {}),
    ...(spec.summary ? { summary: sanitizeLine(spec.summary, 80) } : {}),
  }
}

/** The default handle: the workspace directory's slug (`Payments API` → `payments-api`). */
export function workspaceSlug(workspace: string): string {
  const slug = toNameSlug(basename(workspace) || 'agent', 'agent')
  return isValidName(slug) ? slug : 'agent'
}

/** `hello from @api-server — claude-code · payments-api@main` (ONBOARDING §3 step 5). */
export function helloText(handle: string, kind: AgentKind, workspace: WorkspaceFields | undefined): string {
  const where = workspace?.name ? `${workspace.name}${workspace.branch ? `@${workspace.branch}` : ''}` : ''
  return `hello from @${handle} — ${kind}${where ? ` · ${where}` : ''}`
}

/** Deterministic `client_msg_id` for the hello: a hash of member + room + "hello". */
export function helloMessageId(member: string, roomId: string): string {
  const hash = new Bun.CryptoHasher('sha256').update(`${member}\u0000${roomId}\u0000hello`).digest('hex')
  return `hello-${hash.slice(0, 40)}`
}
