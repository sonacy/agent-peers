/**
 * Steps 2–7 of `join` (ONBOARDING §3). Every step is idempotent and prints one progress line, so a
 * rerun after a tool timeout never consumes another invite use, creates a second member or posts a
 * second hello.
 */
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { listBridges, peersPaths, psProcessTree, ulid } from '@agent-peers/core'
import { sanitizePromptValue } from '@agent-peers/protocol'
import { AGENTS } from '../agents/registry'
import { sourceBinary } from '../assets/binary'
import { versionFor } from '../commands/installer-deps'
import { EXIT } from '../errors'
import { ADAPTER_VERSION, helloMessageId, helloText } from './card'
import type { JoinContext } from './context'
import type { StopReport } from './errors'
import { commandLines, finishBlock, LIVE_AUTOJOIN_KINDS, rosterLines, tryLiveAutojoin } from './finish'
import { openHubSession } from './hub-session'
import { type InstallStepResult, installStep } from './install-step'
import { ensureCredential, type Joined, joinRoom } from './membership'
import { roomLabel } from './preview'
import { rememberedHandles, rememberStep } from './remember'
import { sandboxCommand, sandboxReport } from './sandbox'
import type { JoinOptions, PeersDeps } from './types'

export type Print = (...lines: readonly string[]) => void

const BOOTSTRAP_PREFIX = 'bootstrap-'

/** Indents the detail lines under a step's progress line. */
const detail = (lines: readonly string[]): readonly string[] => lines.map((line) => `      ${line}`)

/** A write to the home that the sandbox refuses (EPERM / EACCES / EROFS) surfaces here, before redeeming. */
async function probeWrite(home: string): Promise<void> {
  await mkdir(home, { recursive: true, mode: 0o700 })
  const probe = join(home, `.write-probe-${process.pid}`)
  await writeFile(probe, '', { mode: 0o600 })
  await rm(probe, { force: true })
}

/**
 * The bootstrap session's local key: the agent's own key, so the bridge later revives the very same
 * session, unless a live local bridge already serves that key (reattaching would fence it).
 */
export async function bootstrapKey(ctx: JoinContext, deps: PeersDeps): Promise<string> {
  const fresh = `${BOOTSTRAP_PREFIX}${(deps.newId ?? (() => ulid()))()}`
  const key = ctx.agent.agentKey
  if (!key) return fresh
  const bridges = await listBridges(peersPaths(ctx.home).run, deps.processTree ?? psProcessTree)
  return bridges.some((bridge) => bridge.local_keys.includes(key)) ? fresh : key
}

export async function detectStep(
  ctx: JoinContext,
  options: JoinOptions,
  key: string,
  print: Print,
): Promise<StopReport | undefined> {
  const reason = ctx.agent.sandboxed
    ? 'CODEX_SANDBOX is set'
    : await probeWrite(ctx.home).then(
        () => undefined,
        (error: unknown) =>
          `cannot write to ${ctx.home}: ${(error as NodeJS.ErrnoException).code ?? String(error)}`,
      )
  if (reason) return sandboxReport(reason, sandboxCommand(ctx, options, ctx.agent.agentKey ?? key))
  const labels = ctx.agent.ids.map((id) => AGENTS[id].label).join(', ') || 'no agent (terminal)'
  const binary = ctx.detections.find((d) => d.id === ctx.agent.ids[0])?.binary
  const running = binary ? ` · running ${binary.path}` : ''
  print(`[2/7] detect: ${labels} (${ctx.agent.mode})${running} · session ${key}`)
  return undefined
}

export async function installAgents(
  ctx: JoinContext,
  deps: PeersDeps,
  print: Print,
): Promise<InstallStepResult> {
  const result = await installStep({
    ids: ctx.agent.ids,
    detections: ctx.detections,
    sys: ctx.sys,
    home: ctx.home,
    version: versionFor(deps),
    source: deps.sourceBinary ?? sourceBinary(ctx.sys.env),
  })
  const [headline = '', ...rest] = result.lines
  print(`[3/7] install: ${headline}`, ...detail(rest))
  return result
}

export interface JoinedRoom extends Joined {
  readonly localKey: string
}

/** Steps 4 and 5: credential, bootstrap session, membership, join and hello. */
export async function membershipAndJoin(
  ctx: JoinContext,
  options: JoinOptions,
  deps: PeersDeps,
  localKey: string,
  print: Print,
): Promise<JoinedRoom | StopReport> {
  const membership = await ensureCredential(ctx.local, deps.fetch ?? fetch, ctx.invite, ctx.memberName)
  const hub = await openHubSession({
    origin: ctx.invite.origin,
    token: membership.token,
    kind: ctx.agent.kind,
    adapter: ADAPTER_VERSION,
    host: ctx.host,
    localKey,
    card: ctx.card,
    ...(ctx.card.agent.version ? { agentVersion: ctx.card.agent.version } : {}),
    ...(options.insecure ? { insecure: true } : {}),
    ...(deps.webSocketFactory ? { webSocketFactory: deps.webSocketFactory } : {}),
    ...(deps.requestTimeoutMs ? { requestTimeoutMs: deps.requestTimeoutMs } : {}),
  })
  try {
    const roomId = ctx.preview.room.room_id
    const owned = await rememberedHandles(ctx.local, ctx.invite.origin, roomId)
    const outcome = await joinRoom({
      session: hub.session,
      roomId,
      code: ctx.invite.code,
      choice: ctx.handle,
      membership,
      ownsHandle: (handle) => owned.includes(handle),
    })
    print(`[4/7] membership: ${outcome.membershipLine}`)
    if (outcome.kind === 'already') {
      print(`[5/7] join: already joined as @${outcome.handle}`)
      return {
        code: EXIT.ok,
        lines: finishBlock([], {}, `@${outcome.handle} is already live in "${roomLabel(ctx.preview)}"`),
      }
    }
    const said = outcome.grantCreated
      ? await sayHello(ctx, hub.session, membership.member, outcome.handle)
      : ''
    const how = outcome.rejoined ? 'already joined' : 'joined'
    print(
      `[5/7] join: ${how} "${roomLabel(ctx.preview)}" as @${outcome.handle}${said}`,
      ...detail(outcome.notes),
    )
    return { ...outcome, localKey }
  } finally {
    await hub.close(true)
  }
}

async function sayHello(
  ctx: JoinContext,
  session: Parameters<typeof joinRoom>[0]['session'],
  member: string,
  handle: string,
): Promise<string> {
  const roomId = ctx.preview.room.room_id
  await session.send({
    room_id: roomId,
    text: helloText(handle, ctx.agent.kind, ctx.workspaceFields),
    client_msg_id: helloMessageId(member || handle, roomId),
  })
  return ' · said hello'
}

export async function rememberAndFinish(
  ctx: JoinContext,
  options: JoinOptions,
  deps: PeersDeps,
  joined: JoinedRoom,
  install: InstallStepResult,
  print: Print,
): Promise<void> {
  const label = roomLabel(ctx.preview)
  const remembered = await rememberStep(ctx.local, {
    origin: ctx.invite.origin,
    roomId: ctx.preview.room.room_id,
    roomLabel: label,
    handle: joined.handle,
    agent: ctx.agent.ids.length > 1 ? 'other' : ctx.agent.kind,
    workspace: ctx.workspace,
    localKey: joined.localKey,
    userHome: ctx.userHome,
    ...(options.remember ? { requested: options.remember } : {}),
  })
  print(`[6/7] remember: ${remembered.line}`)
  const others = joined.members.filter((m) => m.handle !== joined.handle)
  const target = others[0]?.handle ?? 'someone'
  print(
    `[7/7] result: ${joined.members.length} in "${sanitizePromptValue(label)}"`,
    ...detail(rosterLines(joined.members, joined.handle)),
    ...detail(commandLines(ctx.agent.kind, target)),
  )
  const live = await liveNow(ctx, deps, joined, install, remembered.scope !== 'none')
  print(
    ...finishBlock(
      ctx.agent.ids,
      install.methods,
      live ? `@${joined.handle} is live in "${label}" now` : undefined,
    ),
  )
}

/** ONBOARDING §4: an installed adapter can auto-join right away, without a reload. */
async function liveNow(
  ctx: JoinContext,
  deps: PeersDeps,
  joined: JoinedRoom,
  install: InstallStepResult,
  remembered: boolean,
): Promise<boolean> {
  if (!install.alreadyInstalled || !remembered || !LIVE_AUTOJOIN_KINDS.has(ctx.agent.kind)) return false
  return tryLiveAutojoin({
    runDir: peersPaths(ctx.home).run,
    ...(deps.processTree ? { tree: deps.processTree } : {}),
    localKey: ctx.agent.agentKey ?? joined.localKey,
    agentKind: ctx.agent.kind,
    workspace: ctx.workspace,
    ...(deps.controlTimeoutMs ? { timeoutMs: deps.controlTimeoutMs } : {}),
  })
}
