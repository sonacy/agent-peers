/**
 * Step 2 of `join` (ONBOARDING §3): which agent(s) to install into, the agent kind the bootstrap
 * session uses, the agent's own session key and whether a sandbox will block the join.
 */
import { readlink } from 'node:fs/promises'
import { basename, isAbsolute } from 'node:path'
import { ancestorChain, type EnvLike, type ProcessTree } from '@agent-peers/core'
import type { AgentKind } from '@agent-peers/protocol'
import { type Candidate, resolveBinary } from '../agents/binaries'
import { codexGateReason, findCodexCliPath, readCodexConfig } from '../agents/codex'
import type { CurrentAgent } from '../agents/current'
import { AGENTS } from '../agents/registry'
import type { AgentDetection, AgentId, FoundBinary, Sys } from '../agents/types'
import { atLeast, VERSION_GATES } from '../agents/version'
import { clackPrompt, selectAgents } from '../commands/add-select'
import type { InstallerDeps } from '../commands/installer-deps'

export interface JoinAgent {
  /** Agents to install into (first = the one whose session joins). */
  readonly ids: readonly AgentId[]
  /** The bootstrap session's agent kind (`other` when no agent is selected). */
  readonly kind: AgentKind
  /** The agent's own session key (env, `--session-key`, Claude Desktop's fixed key). */
  readonly agentKey?: string
  readonly current?: CurrentAgent
  readonly sandboxed: boolean
  readonly mode: string
}

export type AgentResolution =
  | { readonly kind: 'ok'; readonly agent: JoinAgent }
  | { readonly kind: 'error'; readonly code: number; readonly message: string }

export interface AgentRequest {
  readonly explicit: readonly AgentId[]
  readonly here: boolean
  readonly yes: boolean
  readonly sessionKey?: string
  readonly current?: CurrentAgent
  readonly detections: readonly AgentDetection[]
  readonly interactive: boolean
  readonly previous: readonly AgentId[]
  readonly host: string
  readonly env: EnvLike
}

const CODEX_FAMILY: ReadonlySet<AgentKind> = new Set(['codex', 'codex-desktop'])

const sameFamily = (a: AgentKind | undefined, b: AgentKind): boolean =>
  a === b || (a !== undefined && CODEX_FAMILY.has(a) && CODEX_FAMILY.has(b))

/** The key the agent's bridge will open its session with, when this CLI can know it. */
export function agentSessionKey(request: AgentRequest, kind: AgentKind): string | undefined {
  if (request.sessionKey) return request.sessionKey
  const current = request.current
  if (current?.sessionKey && sameFamily(current.id, kind)) return current.sessionKey
  if (kind === 'claude-desktop') return `claude-desktop@${request.host}`
  const pi = request.env.PI_SESSION_ID?.trim()
  if (current?.name === 'pi' && pi) return pi
  return undefined
}

export async function resolveJoinAgent(
  request: AgentRequest,
  prompt: InstallerDeps['prompt'] = clackPrompt,
): Promise<AgentResolution> {
  const here = request.here || (request.explicit.length === 0 && request.current?.id !== undefined)
  const selection = await selectAgents({
    detections: request.detections,
    explicit: request.explicit,
    here,
    yes: request.yes,
    ...(request.current ? { current: request.current } : {}),
    interactive: request.interactive,
    previous: request.previous,
    prompt,
  })
  if (selection.kind === 'cancelled') return { kind: 'error', code: 1, message: 'cancelled' }
  if (selection.kind === 'error') return { kind: 'error', code: selection.code, message: selection.message }
  const ids = selection.ids
  const kind: AgentKind = ids[0] ?? 'other'
  const agentKey = agentSessionKey(request, kind)
  return {
    kind: 'ok',
    agent: {
      ids,
      kind,
      sandboxed: request.current?.sandboxed === true,
      mode: selection.mode,
      ...(agentKey ? { agentKey } : {}),
      ...(request.current ? { current: request.current } : {}),
    },
  }
}

/** The executable of `pid` (Linux `/proc/<pid>/exe`); undefined when it cannot be read. */
export type ExePath = (pid: number) => Promise<string | undefined>

export const procExePath: ExePath = (pid) => readlink(`/proc/${pid}/exe`).catch(() => undefined)

/**
 * Codex's running binary: the nearest ancestor process named `codex` (ONBOARDING §3 step 2).
 * macOS `ps -o comm=` gives the full path; Linux gives the bare name, so `/proc/<pid>/exe` is read.
 */
export async function codexAncestorBinary(
  tree: ProcessTree,
  pid: number,
  exePath: ExePath = procExePath,
): Promise<string | undefined> {
  const chain = await ancestorChain(tree, pid, { includeSelf: false })
  for (const ancestor of chain) {
    const comm = (await tree.lookup(ancestor))?.comm
    if (!comm || basename(comm) !== 'codex') continue
    if (isAbsolute(comm)) return comm
    const exe = await exePath(ancestor)
    if (exe && isAbsolute(exe)) return exe
  }
  return undefined
}

/** Where the running Codex is: the ancestor binary, then `CODEX_CLI_PATH` in config.toml. */
export async function runningCodexCandidates(
  sys: Sys,
  running: string | undefined,
): Promise<readonly Candidate[]> {
  const config = await readCodexConfig(sys)
  const fromConfig = config ? findCodexCliPath(config) : undefined
  return [
    ...(running ? [{ path: running, source: 'running codex process' }] : []),
    ...(fromConfig ? [{ path: fromConfig, source: 'config.toml CODEX_CLI_PATH' }] : []),
  ]
}

/** Points a Codex detection at `binary`, with the version gate checked against that binary. */
export function withRunningBinary(
  detection: AgentDetection,
  binary: FoundBinary | undefined,
): AgentDetection {
  if (!binary || !AGENTS[detection.id].surface.startsWith('codex')) return detection
  const supported = atLeast(binary.version, VERSION_GATES.codexMin)
  const label = detection.id === 'codex-desktop' ? 'Codex desktop engine' : 'Codex CLI'
  const { reason: _reason, ...rest } = detection
  return {
    ...rest,
    detected: true,
    supported,
    ...(supported ? {} : { reason: codexGateReason(label, binary.version) }),
    binary,
    ...(detection.id === 'codex-desktop' ? { engineVersion: binary.version } : { version: binary.version }),
    evidence: [...detection.evidence, `running codex ${binary.version} at ${binary.path} (${binary.source})`],
  }
}

/** Resolves the running Codex binary and points every Codex detection at it (else leaves them be). */
export async function withRunningCodex(
  sys: Sys,
  detections: readonly AgentDetection[],
  running: string | undefined,
): Promise<readonly AgentDetection[]> {
  const { binary } = await resolveBinary(sys, await runningCodexCandidates(sys, running))
  return detections.map((detection) => withRunningBinary(detection, binary))
}
