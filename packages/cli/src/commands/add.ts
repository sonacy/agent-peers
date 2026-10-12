/**
 * `agent-peers add [-a <agent…>] [--here] [-y] [--dry-run]` (ARCHITECTURE §4): detect, select,
 * install each agent's native plugin, selftest the bridge, then print the finishing step.
 */

import { Command } from 'commander'
import { detectCurrentAgent } from '../agents/current'
import { AGENTS, detectAll } from '../agents/registry'
import type { AgentDetection, AgentId, Sys } from '../agents/types'
import { sourceBinary } from '../assets/binary'
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
import type { CliIo } from '../io'
import { clackPrompt, type Selection, selectAgents } from './add-select'
import {
  collectAgents,
  detectionLine,
  determineFor,
  homeFor,
  type InstallerDeps,
  interactiveFor,
  printer,
  sysFor,
  unique,
  versionFor,
} from './installer-deps'

export interface AddOptions {
  readonly agent?: readonly string[]
  readonly here?: boolean
  readonly yes?: boolean
  readonly dryRun?: boolean
}

/** Exit code when the agent's sandbox blocks the install (ONBOARDING §3 step 2). */
export const SANDBOX_EXIT = 3
export const FINISH_HEADER = '[agent-peers] FINISH:'

const SANDBOX_CODES = new Set(['EPERM', 'EACCES', 'EROFS'])

interface Outcome {
  readonly id: AgentId
  readonly ok: boolean
  readonly method?: string
}

function planLines(detections: readonly AgentDetection[], ids: readonly AgentId[], ctx: InstallContext) {
  const source = 'the running agent-peers binary'
  return [
    'dry run, nothing will change:',
    `  copy ${source} to ${ctx.binary} and point ${ctx.currentBinary} at it`,
    `  write the plugin trees to ${ctx.layout.root}`,
    ...ids.flatMap((id) => {
      const detection = detections.find((d) => d.id === id)
      if (!detection?.supported)
        return [`  ${AGENTS[id].label}: skipped (${detection?.reason ?? 'not found'})`]
      return [
        `  ${detection.label}:`,
        ...installerFor(id)
          .plan(detection, ctx)
          .map((line) => `    ${line}`),
      ]
    }),
  ]
}

function sandboxMessage(command: string): readonly string[] {
  return [
    "agent-peers: blocked by your agent's sandbox (it cannot write outside the workspace).",
    `Rerun with escalated/unsandboxed execution: ${command}`,
    `Or run it in a terminal: ${command}`,
  ]
}

const commandLine = (options: AddOptions, ids: readonly AgentId[]): string =>
  `agent-peers add ${ids.map((id) => `-a ${id}`).join(' ')}${options.yes ? ' -y' : ''}`.trim()

async function installOne(
  detection: AgentDetection | undefined,
  id: AgentId,
  ctx: InstallContext,
  print: (...lines: readonly string[]) => void,
): Promise<Outcome> {
  if (!detection?.supported) {
    print(`${AGENTS[id].label}: skipped (${detection?.reason ?? 'not found'})`)
    return { id, ok: false }
  }
  print(`${detection.label}:`)
  const outcome = await installerFor(id).install(detection, ctx)
  print(...outcome.lines.map((line) => `  ${line}`), `  ${outcome.ok ? 'installed' : 'FAILED'}`)
  return { id, ok: outcome.ok, ...(outcome.method ? { method: outcome.method } : {}) }
}

async function selftests(sys: Sys, ctx: InstallContext, ok: readonly Outcome[]) {
  const surfaces = unique(ok.map((outcome) => AGENTS[outcome.id].surface))
  return Promise.all(surfaces.map((surface) => selftest(sys, ctx.binary, surface)))
}

function record(state: InstallState, outcomes: readonly Outcome[], ctx: InstallContext, now: number) {
  return outcomes
    .filter((outcome) => outcome.ok)
    .reduce(
      (acc, outcome) =>
        withRecord(acc, outcome.id, {
          version: ctx.version,
          method: outcome.method ?? 'unknown',
          binary: ctx.binary,
          installed_at: new Date(now).toISOString(),
        }),
      state,
    )
}

function finishBlock(outcomes: readonly Outcome[]): readonly string[] {
  const done = outcomes.filter((outcome) => outcome.ok)
  if (done.length === 0) return []
  return [
    '',
    FINISH_HEADER,
    ...done.map(
      (outcome) => `  ${AGENTS[outcome.id].label}: ${installerFor(outcome.id).finish(outcome.method)}`,
    ),
  ]
}

interface Resolved {
  readonly sys: Sys
  readonly home: string
  readonly version: string
  readonly detections: readonly AgentDetection[]
  readonly selection: Selection
  readonly sandboxed: boolean
}

async function resolve(options: AddOptions, io: CliIo, deps: InstallerDeps): Promise<Resolved> {
  const sys = sysFor(io, deps)
  const home = homeFor(io, sys)
  const current = await detectCurrentAgent(io.env, determineFor(io, deps))
  const detections = await detectAll(sys)
  const previous = Object.keys(await readInstallState(home)) as AgentId[]
  const selection = await selectAgents({
    detections,
    explicit: unique(options.agent ?? []) as AgentId[],
    here: options.here === true,
    yes: options.yes === true,
    ...(current ? { current } : {}),
    interactive: interactiveFor(io, deps),
    previous,
    prompt: deps.prompt ?? clackPrompt,
  })
  return {
    sys,
    home,
    version: versionFor(deps),
    detections,
    selection,
    sandboxed: current?.sandboxed === true,
  }
}

/** Prints to stderr and returns `code`. */
const fail = (io: CliIo, code: number, ...lines: readonly string[]): number => {
  io.stderr(`${lines.join('\n')}\n`)
  return code
}

/** Installs into the selected agents. Exit 0 when every one succeeded. */
export async function runAdd(options: AddOptions, io: CliIo, deps: InstallerDeps = {}): Promise<number> {
  const print = printer(io)
  const r = await resolve(options, io, deps)
  print('agent-peers: detected agents', ...r.detections.map(detectionLine))
  if (r.selection.kind === 'cancelled') return fail(io, 1, 'agent-peers: cancelled')
  if (r.selection.kind === 'error') return fail(io, r.selection.code, `agent-peers: ${r.selection.message}`)
  const ids = r.selection.ids
  if (ids.length === 0) return fail(io, 1, 'agent-peers: no supported agent selected')
  print(`installing into: ${ids.map((id) => AGENTS[id].label).join(', ')} (${r.selection.mode})`)
  if (options.dryRun) {
    print(...planLines(r.detections, ids, installContext(r.sys, r.home, r.version)))
    return 0
  }
  if (r.sandboxed) return fail(io, SANDBOX_EXIT, ...sandboxMessage(commandLine(options, ids)))
  return install(options, io, deps, r, ids)
}

async function install(
  options: AddOptions,
  io: CliIo,
  deps: InstallerDeps,
  r: Resolved,
  ids: readonly AgentId[],
): Promise<number> {
  const print = printer(io)
  const source = deps.sourceBinary ?? sourceBinary(io.env)
  if (!source)
    return fail(
      io,
      1,
      'agent-peers: no binary to install: run the compiled agent-peers, or set AGENT_PEERS_BINARY',
    )
  let ctx: InstallContext
  try {
    const prepared = await prepareInstall(r.sys, r.home, r.version, source)
    ctx = prepared.ctx
    print(...prepared.lines)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code && SANDBOX_CODES.has(code))
      return fail(io, SANDBOX_EXIT, ...sandboxMessage(commandLine(options, ids)))
    throw error
  }
  const outcomes: Outcome[] = []
  for (const id of ids)
    outcomes.push(
      await installOne(
        r.detections.find((d) => d.id === id),
        id,
        ctx,
        print,
      ),
    )
  const tests = await selftests(
    r.sys,
    ctx,
    outcomes.filter((outcome) => outcome.ok),
  )
  print(...tests.map((test) => test.line))
  await writeInstallState(r.home, record(await readInstallState(r.home), outcomes, ctx, r.sys.now()))
  print(...finishBlock(outcomes))
  const ok = outcomes.every((outcome) => outcome.ok) && tests.every((test) => test.ok)
  return ok ? 0 : 1
}

export function addCommand(io: CliIo, setExit: (code: number) => void, deps: InstallerDeps = {}): Command {
  return new Command('add')
    .description('install agent-peers into your coding agents (Claude Code, Claude Desktop, Codex)')
    .option('-a, --agent <agent...>', 'claude-code, claude-desktop, codex, codex-desktop', collectAgents)
    .option('--here', 'install only into the agent running this command')
    .option('-y, --yes', 'no prompt: install into every supported agent detected')
    .option('--dry-run', 'print what would be done and change nothing')
    .action(async (options: AddOptions) => {
      setExit(await runAdd(options, io, deps))
    })
}
