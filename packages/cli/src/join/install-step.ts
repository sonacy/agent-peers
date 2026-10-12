/**
 * Step 3 of `join` (ONBOARDING §3): install the adapter into the selected agent(s) with the same
 * steps as `add`, non-interactively, skipping agents that already run this version; then selftest
 * the installed bridge and fail loudly when it can't start.
 */
import { AGENTS } from '../agents/registry'
import type { AgentDetection, AgentId, Sys } from '../agents/types'
import {
  type InstallContext,
  type InstallState,
  installContext,
  installerFor,
  prepareInstall,
  readInstallState,
  selftest,
  withRecord,
  writeInstallState,
} from '../install/index'

export interface InstallStepInput {
  readonly ids: readonly AgentId[]
  readonly detections: readonly AgentDetection[]
  readonly sys: Sys
  readonly home: string
  readonly version: string
  readonly source: string | undefined
}

export interface InstallStepResult {
  readonly ok: boolean
  readonly lines: readonly string[]
  /** Every selected agent already had this version: nothing was installed. */
  readonly alreadyInstalled: boolean
  /** How each agent is installed (`marketplace`, `skills-dir`, `config`), for its finishing step. */
  readonly methods: Readonly<Partial<Record<AgentId, string>>>
}

const label = (id: AgentId): string => AGENTS[id].label
const unique = <T>(items: readonly T[]): readonly T[] => [...new Set(items)]

async function isCurrent(sys: Sys, state: InstallState, id: AgentId, version: string): Promise<boolean> {
  const record = state[id]
  return record !== undefined && record.version === version && (await sys.exists(record.binary))
}

async function selftests(sys: Sys, ctx: InstallContext, ids: readonly AgentId[]) {
  const surfaces = unique(ids.map((id) => AGENTS[id].surface))
  return Promise.all(surfaces.map((surface) => selftest(sys, ctx.binary, surface)))
}

interface Installed {
  readonly ok: boolean
  readonly lines: readonly string[]
  readonly state: InstallState
}

async function installPending(
  input: InstallStepInput,
  ctx: InstallContext,
  pending: readonly AgentId[],
  state: InstallState,
): Promise<Installed> {
  const lines: string[] = []
  let next = state
  let ok = true
  for (const id of pending) {
    const detection = input.detections.find((d) => d.id === id)
    if (!detection?.supported) {
      lines.push(`${label(id)}: cannot install (${detection?.reason ?? 'not found'})`)
      ok = false
      continue
    }
    const outcome = await installerFor(id).install(detection, ctx)
    lines.push(`${label(id)}:`, ...outcome.lines.map((line) => `  ${line}`))
    ok = ok && outcome.ok
    if (outcome.ok)
      next = withRecord(next, id, {
        version: ctx.version,
        method: outcome.method ?? 'unknown',
        binary: ctx.binary,
        installed_at: new Date(input.sys.now()).toISOString(),
      })
  }
  return { ok, lines, state: next }
}

function methodsOf(state: InstallState, ids: readonly AgentId[]): InstallStepResult['methods'] {
  return Object.fromEntries(ids.flatMap((id) => (state[id] ? [[id, state[id].method]] : [])))
}

async function finishWithSelftests(
  input: InstallStepInput,
  ctx: InstallContext,
  headline: string,
  installed: Installed,
  alreadyInstalled: boolean,
): Promise<InstallStepResult> {
  const tests = installed.ok ? await selftests(input.sys, ctx, input.ids) : []
  const ok = installed.ok && tests.every((test) => test.ok)
  return {
    ok,
    alreadyInstalled,
    methods: methodsOf(installed.state, input.ids),
    lines: [headline, ...[...installed.lines, ...tests.map((test) => test.line)].map((line) => `  ${line}`)],
  }
}

export async function installStep(input: InstallStepInput): Promise<InstallStepResult> {
  if (input.ids.length === 0)
    return {
      ok: true,
      alreadyInstalled: false,
      methods: {},
      lines: ['skipped: no supported agent selected (run `agent-peers add` to install one later)'],
    }
  const state = await readInstallState(input.home)
  const current = await Promise.all(input.ids.map((id) => isCurrent(input.sys, state, id, input.version)))
  const pending = input.ids.filter((_id, i) => !current[i])
  const names = input.ids.map(label).join(', ')
  if (pending.length === 0) {
    const ctx = installContext(input.sys, input.home, input.version)
    const headline = `already installed in ${names} (${input.version})`
    return finishWithSelftests(input, ctx, headline, { ok: true, lines: [], state }, true)
  }
  if (!input.source)
    return {
      ok: false,
      alreadyInstalled: false,
      methods: {},
      lines: ['no binary to install: run the compiled agent-peers, or set AGENT_PEERS_BINARY'],
    }
  const prepared = await prepareInstall(input.sys, input.home, input.version, input.source)
  const installed = await installPending(input, prepared.ctx, pending, state)
  await writeInstallState(input.home, installed.state)
  const headline = `${installed.ok ? 'installed' : 'FAILED to install'} into ${pending.map(label).join(', ')}`
  const withPrepared = { ...installed, lines: [...prepared.lines, ...installed.lines] }
  return finishWithSelftests(input, prepared.ctx, headline, withPrepared, false)
}
