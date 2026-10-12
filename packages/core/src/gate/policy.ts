/**
 * The peer-turn tool gate (ARCHITECTURE §8, ONBOARDING §5). Pure policy: given whether the session
 * is in a peer turn, the tool and its input, decide allow or deny with a human-readable reason.
 * `allow` means "the gate does not object"; adapters map it to "no decision", never to an approval
 * that would skip the user's own permission prompts.
 */
import type { PeerTurnConfig } from '../config/schemas'
import { exposureProblem, splitGlobList } from './exposure'
import { checkPath, checkPaths, globBase, type ListFiles, type PathContext } from './paths'
import { checkShellCommand } from './shell-check'
import { classifyTool, type PeersTool, type ToolClass } from './tools'

export interface PeerTurnView {
  /** Asks this turn claimed; `peers_reply` / `peers_progress` are allowed for these only. */
  readonly ask_ids: readonly string[]
  /** Rooms the asks came from (for `write_allowlist`). */
  readonly room_ids: readonly string[]
}

export interface GateInput {
  /** `null` when the session is not in a peer turn: everything is allowed. */
  readonly peerTurn: PeerTurnView | null
  readonly tool: string
  readonly input: unknown
  readonly policy: PeerTurnConfig
  readonly workspaceRoot: string
  readonly userHome: string
  /** The hook's cwd, if it differs from the workspace root. */
  readonly cwd?: string
  readonly realpath?: (path: string) => string
  readonly exists?: (path: string) => boolean
  readonly listFiles?: ListFiles
  readonly caseInsensitive?: boolean
}

export interface GateDecision {
  readonly decision: 'allow' | 'deny'
  readonly reason: string
}

const allow = (reason: string): GateDecision => ({ decision: 'allow', reason })
const deny = (reason: string): GateDecision => ({ decision: 'deny', reason: `agent-peers: ${reason}` })

/** Tools that would relay or widen a remote agent's reach (ARCHITECTURE §8 item 3). */
const PEERS_DENY_REASON: Readonly<Partial<Record<PeersTool, string>>> = {
  peers_send: 'peers_send is disabled during a peer turn (no relaying a remote request to other agents)',
  peers_ask: 'peers_ask is disabled during a peer turn (no relaying a remote request to other agents)',
  peers_join: 'peers_join is disabled during a peer turn (a remote agent cannot join rooms for you)',
  peers_leave: 'peers_leave is disabled during a peer turn',
  peers_create: 'peers_create is disabled during a peer turn',
  peers_invite: 'peers_invite is disabled during a peer turn',
  peers_knock: 'peers_knock is disabled during a peer turn',
}

function record(input: unknown): Readonly<Record<string, unknown>> {
  return typeof input === 'object' && input !== null && !Array.isArray(input)
    ? (input as Record<string, unknown>)
    : {}
}

const str = (value: unknown): string | undefined =>
  typeof value === 'string' && value.length > 0 ? value : undefined

function gatePeers(name: PeersTool, input: unknown, turn: PeerTurnView): GateDecision {
  if (name === 'peers_reply' || name === 'peers_progress') {
    const askId = str(record(input).ask_id)
    if (askId && turn.ask_ids.includes(askId)) return allow(`${name} for the claimed ask`)
    return deny(`${name} is allowed only for the ask this turn is answering (${turn.ask_ids.join(', ')})`)
  }
  return deny(PEERS_DENY_REASON[name] ?? `${name} is not allowed during a peer turn`)
}

/** Paths a read tool would touch: `file_path` / `path` / `notebook_path`, or a glob's literal base. */
function readPaths(name: string, input: unknown): readonly string[] {
  const fields = record(input)
  const paths = [str(fields.file_path), str(fields.path), str(fields.notebook_path)].filter(
    (p): p is string => p !== undefined,
  )
  const pattern = str(fields.pattern)
  if (name === 'Glob' && pattern) return [...paths, globBase(pattern)]
  return paths.length > 0 ? paths : ['.']
}

/** `*** Add File: x`, `*** Update File: x`, `*** Delete File: x`, `*** Move to: x` in an apply_patch body. */
export function patchPaths(patch: string): readonly string[] {
  const matches = patch.matchAll(/^\*\*\* (?:Add File|Update File|Delete File|Move to): (.+)$/gm)
  return [...matches].map((m) => (m[1] as string).trim())
}

function writePaths(name: string, input: unknown): readonly string[] {
  const fields = record(input)
  if (name === 'apply_patch') {
    const command = fields.command
    const body =
      str(fields.input) ??
      str(fields.patch) ??
      (Array.isArray(command)
        ? command.find((part) => typeof part === 'string' && part.includes('***'))
        : undefined)
    return typeof body === 'string' ? patchPaths(body) : []
  }
  return [str(fields.file_path), str(fields.path), str(fields.notebook_path)].filter(
    (p): p is string => p !== undefined,
  )
}

function writeAllowed(input: GateInput, name: string): boolean {
  const rooms = input.peerTurn?.room_ids ?? []
  return rooms.length > 0 && rooms.every((room) => (input.policy.write_allowlist[room] ?? []).includes(name))
}

function gateWrite(input: GateInput, ctx: PathContext, name: string): GateDecision {
  if (!writeAllowed(input, name))
    return deny(
      `${name} would modify files; peer turns are read-only unless the room is on your write_allowlist`,
    )
  const paths = writePaths(name, input.input)
  if (paths.length === 0) return deny(`${name}: could not determine which files it would modify`)
  const bad = checkPaths(ctx, paths)
  return bad && !bad.ok ? deny(bad.reason) : allow(`${name} is on the room's write_allowlist`)
}

/** Grep reads every file under its path; its `glob` narrows which (Glob and LS list names only). */
function grepExposure(ctx: PathContext, name: string, input: unknown): string | undefined {
  if (name !== 'Grep') return undefined
  const fields = record(input)
  const globs = splitGlobList(str(fields.glob) ?? '')
  for (const root of readPaths(name, input)) {
    const problem = exposureProblem(ctx, { root, filters: { globs } })
    if (problem) return problem
  }
  return undefined
}

function gateRead(input: GateInput, ctx: PathContext, name: string): GateDecision {
  if (!input.policy.allow_tools.includes(name)) return deny(`${name} is not on the peer-turn tool allowlist`)
  const bad = checkPaths(ctx, readPaths(name, input.input))
  if (bad && !bad.ok) return deny(bad.reason)
  const exposed = grepExposure(ctx, name, input.input)
  return exposed ? deny(exposed) : allow(`${name} inside the workspace`)
}

function gateShell(input: GateInput, ctx: PathContext): GateDecision {
  const fields = record(input.input)
  const workdir = str(fields.workdir) ?? str(fields.cwd)
  // The command runs in the hook cwd (or `workdir`): it must itself be inside the workspace.
  const dir = checkPath(ctx, workdir ?? '.')
  if (!dir.ok) return deny(`the command's working directory: ${dir.reason}`)
  const shellCtx: PathContext = { ...ctx, cwd: dir.path }
  const verdict = checkShellCommand(fields.command ?? fields.cmd, input.policy.allow_commands, shellCtx)
  return verdict.ok ? allow('read-only command inside the workspace') : deny(verdict.reason)
}

function gateClass(input: GateInput, ctx: PathContext, tool: ToolClass): GateDecision {
  switch (tool.kind) {
    case 'peers':
      return gatePeers(tool.name, input.input, input.peerTurn as PeerTurnView)
    case 'read':
      return gateRead(input, ctx, tool.name)
    case 'shell':
      return gateShell(input, ctx)
    case 'write':
      return gateWrite(input, ctx, tool.name)
    default:
      if (input.policy.allow_tools.includes(tool.name) || writeAllowed(input, tool.name))
        return allow(`${tool.name} is allowlisted`)
      return deny(`${tool.name} is not on the peer-turn tool allowlist`)
  }
}

function pathContext(input: GateInput): PathContext {
  return {
    workspaceRoot: input.workspaceRoot,
    userHome: input.userHome,
    denyGlobs: input.policy.deny_globs,
    ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
    ...(input.realpath === undefined ? {} : { realpath: input.realpath }),
    ...(input.exists === undefined ? {} : { exists: input.exists }),
    ...(input.listFiles === undefined ? {} : { listFiles: input.listFiles }),
    ...(input.caseInsensitive === undefined ? {} : { caseInsensitive: input.caseInsensitive }),
  }
}

/**
 * Evaluates one tool call. Outside a peer turn the gate never objects. During one it fails closed:
 * an exception while evaluating (a probe failing, an unexpected input) is a deny, never an allow.
 */
export function evaluateGate(input: GateInput): GateDecision {
  if (input.peerTurn === null) return allow('not in a peer turn')
  try {
    return gateClass(input, pathContext(input), classifyTool(input.tool))
  } catch (error) {
    return deny(`the tool call could not be checked (${String(error)})`)
  }
}

export interface PermissionInput {
  readonly peerTurn: PeerTurnView | null
  readonly tool: string
  readonly input?: unknown
  /**
   * Asks this session answered inside a gated peer turn. Outside a turn only these are pre-approved:
   * an ask the model saw without the gate (an inbox listing) is left to the user.
   */
  readonly gatedAskIds?: readonly string[]
}

export interface PermissionDecision {
  /** `true` pre-approves; `undefined` leaves the decision to the user. Never `false`: denials are the gate's job. */
  readonly allow?: true
  readonly reason: string
}

/**
 * PermissionRequest pre-approval (ARCHITECTURE §6.1): only `peers_reply` / `peers_progress` for an
 * ask that went through a gated peer turn: during the turn, its claimed asks; outside it, asks an
 * earlier gated turn answered. `peers_join` / `peers_create` / `peers_invite` are never
 * pre-approved (§8 item 4).
 */
export function evaluatePermission(request: PermissionInput): PermissionDecision {
  const tool = classifyTool(request.tool)
  if (tool.kind !== 'peers' || (tool.name !== 'peers_reply' && tool.name !== 'peers_progress'))
    return { reason: 'left to the user' }
  const askId = str(record(request.input).ask_id)
  if (request.peerTurn === null) {
    if (askId !== undefined && (request.gatedAskIds ?? []).includes(askId))
      return { allow: true, reason: `${tool.name} for an ask answered in a gated peer turn` }
    return { reason: 'outside a peer turn, replies to asks the gate never covered are left to the user' }
  }
  if (askId === undefined || request.peerTurn.ask_ids.includes(askId))
    return { allow: true, reason: `${tool.name} for the claimed ask` }
  return { reason: 'ask_id is not the ask this turn is answering' }
}
