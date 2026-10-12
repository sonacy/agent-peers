/**
 * `agent-peers doctor [--json]` (ARCHITECTURE §4): checks every agent end to end and exits 1 when
 * any check fails (warnings and skipped checks do not fail).
 */
import { Command } from 'commander'
import { detectAll } from '../agents/registry'
import type { AgentDetection, AgentId } from '../agents/types'
import { type InstallContext, installContext, readInstallState } from '../install/index'
import type { CliIo } from '../io'
import {
  agentStatus,
  type Check,
  type CheckStatus,
  checkBinary,
  checkBridges,
  checkConfig,
  checkDetection,
  checkGate,
  checkHooks,
  checkHub,
  checkPlugin,
  checkSelftests,
  isRecorded,
  knownHubs,
} from './doctor-checks'
import { homeFor, type InstallerDeps, printer, sysFor, versionFor } from './installer-deps'

export interface DoctorOptions {
  readonly json?: boolean
}

export const DEFAULT_PROBE_TIMEOUT_MS = 5_000

export interface DoctorReport {
  readonly ok: boolean
  readonly checks: readonly Check[]
}

interface AgentChecks {
  readonly checks: readonly Check[]
  readonly installed: boolean
}

async function checkAgent(
  detection: AgentDetection,
  recorded: boolean,
  ctx: InstallContext,
): Promise<AgentChecks> {
  const detect = checkDetection(detection, recorded)
  if (!detection.detected && !recorded) return { checks: [detect], installed: false }
  const status = await agentStatus(detection, ctx)
  const optional = [checkHooks(detection.id, status), await checkGate(detection.id, status, ctx)]
  return {
    installed: status.installed,
    checks: [
      detect,
      checkPlugin(detection.id, status, recorded),
      ...optional.filter((c): c is Check => c !== undefined),
    ],
  }
}

/** Runs every check. Pure apart from the probes; the command renders the report. */
export async function runDoctorChecks(io: CliIo, deps: InstallerDeps = {}): Promise<DoctorReport> {
  const sys = sysFor(io, deps)
  const home = homeFor(io, sys)
  const ctx = installContext(sys, home, versionFor(deps))
  const timeoutMs = deps.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS
  const state = await readInstallState(home)
  const detections = await detectAll(sys)
  const perAgent = await Promise.all(detections.map((d) => checkAgent(d, isRecorded(state, d.id), ctx)))
  const installed: AgentId[] = detections.filter((_d, i) => perAgent[i]?.installed).map((d) => d.id)
  const hubs = await knownHubs(home, sys)
  const fetchFn = deps.fetch ?? fetch
  const checks: Check[] = [
    await checkBinary(ctx),
    await checkConfig(home, sys),
    ...perAgent.flatMap((agent) => agent.checks),
    ...(installed.length > 0 ? await checkSelftests(ctx, installed) : []),
    await checkBridges(home, timeoutMs),
    ...(hubs.length > 0
      ? await Promise.all(hubs.map((hub) => checkHub(hub, fetchFn, timeoutMs)))
      : [{ id: 'hub', status: 'skip' as const, summary: 'no hub configured yet (join a room first)' }]),
  ]
  return { ok: checks.every((c) => c.status !== 'fail'), checks }
}

const LABEL: Readonly<Record<CheckStatus, string>> = { ok: 'ok  ', warn: 'warn', fail: 'FAIL', skip: 'skip' }

export function renderReport(report: DoctorReport): readonly string[] {
  const count = (status: CheckStatus) => report.checks.filter((c) => c.status === status).length
  return [
    'agent-peers doctor',
    ...report.checks.map((c) => `  ${LABEL[c.status]}  ${c.agent ? `${c.agent} ` : ''}${c.id}: ${c.summary}`),
    `${count('ok')} ok, ${count('warn')} warnings, ${count('fail')} failed, ${count('skip')} skipped`,
  ]
}

export async function runDoctor(
  options: DoctorOptions,
  io: CliIo,
  deps: InstallerDeps = {},
): Promise<number> {
  const report = await runDoctorChecks(io, deps)
  if (options.json) io.stdout(`${JSON.stringify(report, null, 2)}\n`)
  else printer(io)(...renderReport(report))
  return report.ok ? 0 : 1
}

export function doctorCommand(io: CliIo, setExit: (code: number) => void, deps: InstallerDeps = {}): Command {
  return new Command('doctor')
    .description('check every agent end to end: plugin, hooks, MCP, bridge, gate, hub')
    .option('--json', 'print the report as JSON')
    .action(async (options: DoctorOptions, self: Command) => {
      // `--json` is also a global flag: the root consumes it wherever it appears.
      const json = options.json === true || self.optsWithGlobals<DoctorOptions>().json === true
      setExit(await runDoctor({ ...options, json }, io, deps))
    })
}
