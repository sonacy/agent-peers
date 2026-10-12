/**
 * Bridge info files and discovery (ARCHITECTURE §5). Each bridge writes `run/<pid>.json` with its
 * `agent_pid`, the agent process that launched it; a hook walks its own ancestors nearest first and
 * picks the bridges whose agent is one of them, preferring the one that owns its `local_key`. A
 * shared ancestor further up (a shell, a terminal, a tmux server) never matches, so a hook whose own
 * bridge is not up yet finds none instead of another session's bridge. Files of dead PIDs are removed.
 */
import { AgentKindFieldSchema, MAX_LOCAL_KEY_LENGTH } from '@agent-peers/protocol'
import { z } from 'zod'
import { readTextIfExists, writePrivateFileAtomic } from '../config/fs'
import { infoPathFor, socketPathFor } from '../config/paths'
import { listRunPids, removeRunFiles } from '../config/run-dir'
import { agentAncestor, ancestorChain, type ProcessTree, psProcessTree } from './process-tree'

export const BridgeInfoFileSchema = z.object({
  pid: z.number().int().positive(),
  ancestor_pids: z.array(z.number().int().positive()).max(64),
  /** The agent process (nearest non-launcher ancestor). Absent in files of older bridges. */
  agent_pid: z.number().int().positive().optional(),
  agent_kind: AgentKindFieldSchema,
  local_keys: z.array(z.string().min(1).max(MAX_LOCAL_KEY_LENGTH)).max(1024),
  started_at: z.number().int().nonnegative(),
})
export type BridgeInfoFile = z.output<typeof BridgeInfoFileSchema>

export interface BridgeInfo extends BridgeInfoFile {
  readonly socket: string
}

export async function writeBridgeInfo(runDir: string, info: BridgeInfoFile): Promise<void> {
  const parsed = BridgeInfoFileSchema.parse(info)
  await writePrivateFileAtomic(infoPathFor(runDir, parsed.pid), `${JSON.stringify(parsed)}\n`)
}

/** Reads `run/<pid>.json`; undefined when missing or malformed. */
export async function readBridgeInfo(runDir: string, pid: number): Promise<BridgeInfo | undefined> {
  let text: string | undefined
  try {
    text = await readTextIfExists(infoPathFor(runDir, pid))
  } catch {
    return undefined
  }
  if (text === undefined) return undefined
  try {
    const parsed = BridgeInfoFileSchema.safeParse(JSON.parse(text))
    if (!parsed.success || parsed.data.pid !== pid) return undefined
    return { ...parsed.data, socket: socketPathFor(runDir, pid) }
  } catch {
    return undefined
  }
}

/** Live bridges in `runDir`. Files of dead PIDs (and orphan sockets) are removed on the way. */
export async function listBridges(
  runDir: string,
  tree: ProcessTree = psProcessTree,
): Promise<readonly BridgeInfo[]> {
  const bridges: BridgeInfo[] = []
  for (const pid of await listRunPids(runDir)) {
    if (!tree.isAlive(pid)) {
      await removeRunFiles(runDir, pid)
      continue
    }
    const info = await readBridgeInfo(runDir, pid)
    if (info) bridges.push(info)
  }
  return bridges
}

export interface DiscoverOptions {
  readonly runDir: string
  /** The caller's pid (default `process.pid`); the walk starts at its parent. */
  readonly pid?: number
  readonly localKey?: string
  readonly tree?: ProcessTree
}

/** Whether `bridge` serves the agent process `ancestor` (legacy files: any shared ancestor). */
function servesAncestor(bridge: BridgeInfo, ancestor: number): boolean {
  if (bridge.agent_pid !== undefined) return bridge.agent_pid === ancestor
  return bridge.ancestor_pids.includes(ancestor) || bridge.pid === ancestor
}

/**
 * Bridges serving the caller's agent process, best first: those whose agent is the caller's nearest
 * matching ancestor, with the bridge that owns `localKey` ahead of the rest. Empty when none is found.
 */
export async function discoverBridges(options: DiscoverOptions): Promise<readonly BridgeInfo[]> {
  const tree = options.tree ?? psProcessTree
  const bridges = await listBridges(options.runDir, tree)
  if (bridges.length === 0) return []
  const chain = await ancestorChain(tree, options.pid ?? process.pid, { includeSelf: false })
  for (const ancestor of chain) {
    const matches = bridges.filter((bridge) => servesAncestor(bridge, ancestor))
    if (matches.length === 0) continue
    const key = options.localKey
    if (key === undefined) return matches
    const owners = matches.filter((bridge) => bridge.local_keys.includes(key))
    return [...owners, ...matches.filter((bridge) => !bridge.local_keys.includes(key))]
  }
  return []
}

/** The ancestors a bridge advertises: itself and its parents up to (not including) PID 1/launchd. */
export function bridgeAncestors(
  tree: ProcessTree = psProcessTree,
  pid: number = process.pid,
): Promise<readonly number[]> {
  return ancestorChain(tree, pid, { includeSelf: true })
}

/** The agent process a bridge serves: its nearest ancestor that is not a launcher (sh, npx, node…). */
export function bridgeAgent(
  tree: ProcessTree = psProcessTree,
  pid: number = process.pid,
): Promise<number | undefined> {
  return agentAncestor(tree, pid)
}
