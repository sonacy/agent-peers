/**
 * Everything `join` works out before it changes anything: the invite, local home and config, the
 * agent (step 2's detection, used by the step 1 preview too), the handle and the card.
 */
import { realpath } from 'node:fs/promises'
import { resolve } from 'node:path'
import { type Credential, hubOrigin, type LocalConfig, LocalHome, psProcessTree } from '@agent-peers/core'
import { type CardInput, isValidName, parseInviteUrl } from '@agent-peers/protocol'
import { detectCurrentAgent } from '../agents/current'
import { detectAll } from '../agents/registry'
import type { AgentDetection, AgentId, Sys } from '../agents/types'
import { determineFor, homeFor, interactiveFor, sysFor, unique } from '../commands/installer-deps'
import { EXIT } from '../errors'
import { readInstallState } from '../install/index'
import type { CliIo } from '../io'
import {
  ADAPTER_VERSION,
  buildCard,
  readGitInfo,
  shortHost,
  type WorkspaceFields,
  workspaceFields,
} from './card'
import { codexAncestorBinary, type JoinAgent, resolveJoinAgent, withRunningCodex } from './detect'
import type { StopReport } from './errors'
import type { InvitePreview } from './hub-http'
import type { HandleChoice } from './membership'
import { chooseHandle } from './preview'
import type { JoinOptions, PeersDeps } from './types'

export interface Invite {
  readonly url: string
  readonly origin: string
  readonly code: string
}

export interface LocalSetup {
  readonly invite: Invite
  readonly sys: Sys
  readonly home: string
  readonly userHome: string
  readonly local: LocalHome
  readonly config: LocalConfig
  /** Realpath of the working directory. */
  readonly workspace: string
  readonly host: string
  readonly detections: readonly AgentDetection[]
  readonly agent: JoinAgent
  readonly credential: Credential | undefined
}

export interface JoinContext extends LocalSetup {
  readonly preview: InvitePreview
  readonly handle: HandleChoice
  readonly memberName: string
  readonly workspaceFields: WorkspaceFields | undefined
  readonly card: CardInput
}

export type Setup<T> =
  | { readonly kind: 'ok'; readonly value: T }
  | { readonly kind: 'stop'; readonly report: StopReport }

const usage = (message: string): Setup<never> => ({
  kind: 'stop',
  report: { code: EXIT.usage, lines: [`agent-peers: ${message}`] },
})

export const stripAt = (value: string): string => value.trim().replace(/^@/, '')

/**
 * Host names and IP literals only. WHATWG URL parsing keeps `;`, `$()` and backticks in a host, and
 * the origin ends up in printed shell commands, so anything else is not an invite link.
 */
const STRICT_HOST = /^(?:[a-z0-9-]+(?:\.[a-z0-9-]+)*\.?|\[[0-9a-f:.]+\])$/i

export function isStrictHost(hostname: string): boolean {
  return STRICT_HOST.test(hostname)
}

function parseInvite(url: string): Invite | undefined {
  try {
    const parsed = parseInviteUrl(url)
    const origin = hubOrigin(parsed.origin)
    if (!isStrictHost(new URL(origin).hostname)) return undefined
    return { url, origin, code: parsed.code }
  } catch {
    return undefined
  }
}

async function detections(sys: Sys, io: CliIo, deps: PeersDeps, current: boolean) {
  const found = await detectAll(sys)
  if (!current || !io.env.CODEX_THREAD_ID) return found
  const running = await codexAncestorBinary(deps.processTree ?? psProcessTree, process.pid, deps.exePath)
  return withRunningCodex(sys, found, running)
}

function validate(options: JoinOptions): string | undefined {
  if (options.handle !== undefined && !isValidName(stripAt(options.handle)))
    return `--handle: "${options.handle}" is not a valid handle (a-z, 0-9, - and _; at most 32)`
  if (options.name !== undefined && !isValidName(options.name))
    return `--name: "${options.name}" is not a valid member name (a-z, 0-9, - and _; at most 32)`
  if (options.here && (options.agent?.length ?? 0) > 0) return 'pass either --here or -a <agent>, not both'
  return undefined
}

/** Local, side-effect-free setup (no network). */
export async function localSetup(
  url: string,
  options: JoinOptions,
  io: CliIo,
  deps: PeersDeps,
): Promise<Setup<LocalSetup>> {
  const invite = parseInvite(url)
  if (!invite) return usage(`"${url}" is not an invite link (https://<hub>/j/<code>)`)
  const invalid = validate(options)
  if (invalid) return usage(invalid)
  const sys = sysFor(io, deps)
  const home = homeFor(io, sys)
  const local = new LocalHome({ root: home, userHome: sys.home })
  const cwd = deps.cwd ?? process.cwd()
  const current = await detectCurrentAgent(io.env, determineFor(io, deps))
  const found = await detections(sys, io, deps, current !== undefined)
  const host = shortHost(deps.hostname)
  const resolution = await resolveJoinAgent(
    {
      explicit: unique(options.agent ?? []) as AgentId[],
      here: options.here === true,
      yes: options.yes === true,
      ...(options.sessionKey ? { sessionKey: options.sessionKey } : {}),
      ...(current ? { current } : {}),
      detections: found,
      interactive: interactiveFor(io, deps),
      previous: Object.keys(await readInstallState(home)) as AgentId[],
      host,
      env: io.env,
    },
    deps.prompt,
  )
  if (resolution.kind === 'error')
    return { kind: 'stop', report: { code: resolution.code, lines: [`agent-peers: ${resolution.message}`] } }
  const value: LocalSetup = {
    invite,
    sys,
    home,
    userHome: sys.home,
    local,
    config: await local.readConfig(),
    workspace: await realpath(cwd).catch(() => resolve(cwd)),
    host,
    detections: found,
    agent: resolution.agent,
    credential: await local.credentialFor(invite.origin),
  }
  return { kind: 'ok', value }
}

/** Adds the preview, the handle, the member name and the card. */
export async function joinContext(
  setup: LocalSetup,
  preview: InvitePreview,
  options: JoinOptions,
): Promise<JoinContext> {
  const remembered = (await setup.local.readAutojoin()).find(
    (e) =>
      e.hub === setup.invite.origin && e.room_id === preview.room.room_id && e.workspace === setup.workspace,
  )
  const explicit = options.handle === undefined ? undefined : stripAt(options.handle)
  const handle = chooseHandle(explicit, remembered, setup.config, setup.workspace)
  const fields = workspaceFields(
    setup.config.workspace.share,
    setup.workspace,
    await readGitInfo(setup.workspace),
  )
  const primary = setup.agent.ids[0]
  const agentVersion = setup.detections.find((d) => d.id === primary)?.version
  const card = buildCard({
    kind: setup.agent.kind,
    host: setup.host,
    adapter: ADAPTER_VERSION,
    ...(agentVersion ? { agentVersion } : {}),
    ...(fields ? { workspace: fields } : {}),
    ...(options.summary ? { summary: options.summary } : {}),
  })
  const memberName = setup.credential?.member ?? options.name ?? handle.name
  return { ...setup, preview, handle, memberName, workspaceFields: fields, card }
}
