/**
 * `<home>/installs.json`: what `add` installed, per agent. `add` pre-checks these agents, `remove`
 * defaults to them, `doctor` checks them. Unknown or malformed content reads as empty.
 */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { writePrivateFileAtomic } from '@agent-peers/core'
import { AGENT_IDS, type AgentId } from '../agents/types'

export const INSTALL_STATE_FILE = 'installs.json'

export interface InstallRecord {
  readonly version: string
  readonly method: string
  readonly binary: string
  readonly installed_at: string
}

export type InstallState = Readonly<Partial<Record<AgentId, InstallRecord>>>

const RECORD_LIMITS: Readonly<Record<keyof InstallRecord, number>> = {
  version: 64,
  method: 32,
  binary: 4096,
  installed_at: 64,
}

const isObject = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** A valid record (every field a non-empty bounded string), else undefined. */
export function parseRecord(value: unknown): InstallRecord | undefined {
  if (!isObject(value)) return undefined
  const fields = Object.entries(RECORD_LIMITS).map(([key, max]) => {
    const field = value[key]
    return typeof field === 'string' && field.length > 0 && field.length <= max ? field : undefined
  })
  const [version, method, binary, installed_at] = fields
  if (!version || !method || !binary || !installed_at) return undefined
  return { version, method, binary, installed_at }
}

export const installStatePath = (home: string): string => join(home, INSTALL_STATE_FILE)

export async function readInstallState(home: string): Promise<InstallState> {
  let raw: unknown
  try {
    raw = JSON.parse(await readFile(installStatePath(home), 'utf8'))
  } catch {
    return {}
  }
  const agents = isObject(raw) && isObject(raw.agents) ? raw.agents : {}
  const entries = AGENT_IDS.flatMap((id) => {
    const record = parseRecord(agents[id])
    return record ? [[id, record] as const] : []
  })
  return Object.fromEntries(entries)
}

export async function writeInstallState(home: string, state: InstallState): Promise<void> {
  await writePrivateFileAtomic(installStatePath(home), `${JSON.stringify({ agents: state }, null, 2)}\n`)
}

export const withRecord = (state: InstallState, id: AgentId, record: InstallRecord): InstallState => ({
  ...state,
  [id]: record,
})

export function withoutRecord(state: InstallState, id: AgentId): InstallState {
  const { [id]: _removed, ...rest } = state
  return rest
}

export const installedIds = (state: InstallState): readonly AgentId[] =>
  AGENT_IDS.filter((id) => state[id] !== undefined)
