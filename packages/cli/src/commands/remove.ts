/**
 * `agent-peers remove [-a <agent…>] [--dry-run]` (ARCHITECTURE §4 "remove reverses every step"):
 * uninstall the plugin or config entry from each agent, then, once nothing is installed, the
 * plugin trees and binaries. config.json, credentials and the inbox are kept.
 */
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { Command } from 'commander'
import { AGENTS, detectAll } from '../agents/registry'
import type { AgentDetection, AgentId } from '../agents/types'
import { removeBinaries } from '../assets/binary'
import {
  type InstallContext,
  type InstallState,
  installContext,
  installedIds,
  installerFor,
  readInstallState,
  SHARED_INSTALL,
  withoutRecord,
  writeInstallState,
} from '../install/index'
import type { CliIo } from '../io'
import {
  collectAgents,
  homeFor,
  type InstallerDeps,
  printer,
  sysFor,
  unique,
  versionFor,
} from './installer-deps'

export interface RemoveOptions {
  readonly agent?: readonly string[]
  readonly dryRun?: boolean
}

/** Recorded installs plus detected agents whose status says installed (a lost installs.json). */
async function targets(
  state: InstallState,
  detections: readonly AgentDetection[],
  ctx: InstallContext,
): Promise<readonly AgentId[]> {
  const found = await Promise.all(
    detections
      .filter((detection) => detection.detected && state[detection.id] === undefined)
      .map(async (detection) =>
        (await installerFor(detection.id).status(detection, ctx)).installed ? [detection.id] : [],
      ),
  )
  return unique([...installedIds(state), ...found.flat()])
}

/** Codex CLI and desktop share one plugin install: keep it while the other one stays. */
function sharedKeeper(id: AgentId, removing: readonly AgentId[], state: InstallState): AgentId | undefined {
  const other = SHARED_INSTALL[id]
  return other && state[other] !== undefined && !removing.includes(other) ? other : undefined
}

async function removeOne(
  id: AgentId,
  detection: AgentDetection,
  ctx: InstallContext,
  keeper: AgentId | undefined,
): Promise<{ readonly ok: boolean; readonly lines: readonly string[] }> {
  if (keeper) {
    return {
      ok: true,
      lines: [`kept the shared plugin install: ${AGENTS[keeper].label} still uses it (same CODEX_HOME)`],
    }
  }
  const outcome = await installerFor(id).uninstall(detection, ctx)
  return { ok: outcome.ok, lines: outcome.lines.length > 0 ? outcome.lines : ['nothing to remove'] }
}

/** With every agent removed, the plugin trees and binaries go too. */
async function purgeIfEmpty(home: string, state: InstallState): Promise<readonly string[]> {
  if (installedIds(state).length > 0) return []
  await rm(join(home, 'plugins'), { recursive: true, force: true })
  await removeBinaries(home)
  return [`removed ${join(home, 'plugins')} and ${join(home, 'bin')} (config and credentials kept)`]
}

export async function runRemove(
  options: RemoveOptions,
  io: CliIo,
  deps: InstallerDeps = {},
): Promise<number> {
  const print = printer(io)
  const sys = sysFor(io, deps)
  const home = homeFor(io, sys)
  const ctx = installContext(sys, home, versionFor(deps))
  const state = await readInstallState(home)
  const detections = await detectAll(sys)
  const ids = options.agent?.length
    ? (unique(options.agent) as AgentId[])
    : await targets(state, detections, ctx)
  if (ids.length === 0) {
    print('agent-peers: nothing to remove')
    return 0
  }
  if (options.dryRun) {
    print('dry run, would remove agent-peers from:', ...ids.map((id) => `  ${AGENTS[id].label}`))
    return 0
  }
  let next = state
  let ok = true
  for (const id of ids) {
    const detection = detections.find((d) => d.id === id) ?? (await AGENTS[id].detect(sys))
    const result = await removeOne(id, detection, ctx, sharedKeeper(id, ids, state))
    print(
      `${AGENTS[id].label}:`,
      ...result.lines.map((line) => `  ${line}`),
      `  ${result.ok ? 'removed' : 'FAILED'}`,
    )
    ok = ok && result.ok
    if (result.ok) next = withoutRecord(next, id)
  }
  await writeInstallState(home, next)
  print(...(await purgeIfEmpty(home, next)))
  return ok ? 0 : 1
}

export function removeCommand(io: CliIo, setExit: (code: number) => void, deps: InstallerDeps = {}): Command {
  return new Command('remove')
    .description('remove agent-peers from your agents (default: every agent it was added to)')
    .option('-a, --agent <agent...>', 'claude-code, claude-desktop, codex, codex-desktop', collectAgents)
    .option('--dry-run', 'print what would be removed and change nothing')
    .action(async (options: RemoveOptions) => {
      setExit(await runRemove(options, io, deps))
    })
}
