/**
 * The card a session opens with (PROTOCOL §3). Workspace fields follow `workspace.share`
 * (`none | name | full`); absolute paths never leave the machine.
 */
import { realpath } from 'node:fs/promises'
import { hostname } from 'node:os'
import { basename, join } from 'node:path'
import type { WorkspaceShare } from '@agent-peers/core'
import { type CardInput, type InjectTier, sanitizeLine } from '@agent-peers/protocol'
import type { SurfaceDescriptor } from '../surface/surfaces'

/** The adapter version advertised in `hello` and on cards. */
export const ADAPTER_VERSION = '0.1.0'

export interface GitInfo {
  readonly branch?: string
  readonly remote?: string
}

export interface CardSpec {
  readonly descriptor: SurfaceDescriptor
  readonly host: string
  readonly agentVersion?: string
  readonly tier: InjectTier
  readonly share: WorkspaceShare
  readonly workspace?: string
  readonly git?: GitInfo
  readonly model?: string
}

/** Short, single-line host name (`gulei-mbp.local` → `gulei-mbp`). */
export function shortHost(name: string = hostname()): string {
  const short = sanitizeLine(name.split('.')[0] ?? '', 64)
  return short.length > 0 ? short : 'host'
}

/** `realpath`, or undefined when the path does not exist. */
export async function resolveWorkspace(path: string | undefined): Promise<string | undefined> {
  if (path === undefined || path.trim() === '') return undefined
  try {
    return await realpath(path)
  } catch {
    return undefined
  }
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

/** Reads the branch and `origin` remote straight from `.git` (no git process). */
export async function readGitInfo(workspace: string): Promise<GitInfo> {
  try {
    const head = await readText(join(workspace, '.git', 'HEAD'))
    const config = await readText(join(workspace, '.git', 'config'))
    const branch = /^ref: refs\/heads\/(.+)$/m.exec(head ?? '')?.[1]?.trim()
    const section = /\[remote "origin"\]([^[]*)/.exec(config ?? '')?.[1] ?? ''
    const url = /^\s*url\s*=\s*(.+)$/m.exec(section)?.[1]
    const remote = url ? normalizeRemote(url) : undefined
    return { ...(branch ? { branch } : {}), ...(remote ? { remote } : {}) }
  } catch {
    return {}
  }
}

function workspaceFields(spec: CardSpec): CardInput['workspace'] {
  if (spec.share === 'none' || spec.workspace === undefined) return undefined
  const name = sanitizeLine(basename(spec.workspace), 80)
  if (spec.share === 'name') return name ? { name } : undefined
  return {
    ...(name ? { name } : {}),
    ...(spec.git?.remote ? { git_remote: spec.git.remote } : {}),
    ...(spec.git?.branch ? { branch: sanitizeLine(spec.git.branch, 80) } : {}),
  }
}

export function buildCard(spec: CardSpec): CardInput {
  const workspace = workspaceFields(spec)
  const title = workspace?.name
  return {
    agent: {
      kind: spec.descriptor.agentKind,
      adapter: ADAPTER_VERSION,
      ...(spec.agentVersion ? { version: spec.agentVersion.slice(0, 64) } : {}),
    },
    host: spec.host,
    inject: spec.tier,
    activity: 'unknown',
    ...(spec.model ? { model: spec.model } : {}),
    ...(workspace ? { workspace } : {}),
    ...(title ? { title: title.slice(0, 40) } : {}),
  }
}
