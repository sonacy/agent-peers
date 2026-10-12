/**
 * Claude Code (ARCHITECTURE §4): install through Claude's own plugin CLI from the local marketplace
 * under `<home>/plugins/<v>/marketplace`, in one step on 2.1.292+ (`install --marketplace`) and in
 * two steps before that. When the CLI is missing or fails, fall back to the skills dir.
 */
import type { AgentDetection } from '../agents/types'
import { atLeast, VERSION_GATES } from '../agents/version'
import { MARKETPLACE_NAME, PLUGIN_ID, PLUGIN_NAME } from '../assets/materialize'
import { hasOurSkillsDir, installSkillsDir, removeSkillsDir, skillsDirPath } from './claude-skills-dir'
import { type CliStep, describeStep, isJsonObject, parseJsonOutput, runCliStep } from './exec'
import type { AgentStatus, InstallContext, Installer, StepOutcome } from './types'

const ALREADY_INSTALLED = /already installed|already on disk|already enabled/i
const NOT_PRESENT = /not installed|not found|not declared|no marketplace|unknown marketplace/i

const jsonFlag = (version: string | undefined, min: string): readonly string[] =>
  atLeast(version, min) ? ['--json'] : []

/** The argv lists `add` runs, for the dry-run plan and for install. */
export function claudeInstallCommands(claude: string, version: string | undefined, dir: string) {
  if (atLeast(version, VERSION_GATES.claudeMarketplaceFlag)) {
    return [[claude, 'plugin', 'install', PLUGIN_NAME, '--marketplace', dir, '--scope', 'user', '--json']]
  }
  return [
    [claude, 'plugin', 'marketplace', 'add', dir, ...jsonFlag(version, VERSION_GATES.claudeMarketplaceJson)],
    [
      claude,
      'plugin',
      'install',
      PLUGIN_ID,
      '--scope',
      'user',
      ...jsonFlag(version, VERSION_GATES.claudeInstallJson),
    ],
  ]
}

interface MarketplaceEntry {
  readonly name: string
  readonly path?: string
}

/** `claude plugin marketplace list --json`; empty when the command is unsupported or fails. */
async function listMarketplaces(ctx: InstallContext, claude: string): Promise<readonly MarketplaceEntry[]> {
  const result = await ctx.sys.run([claude, 'plugin', 'marketplace', 'list', '--json'], { timeoutMs: 30_000 })
  if (result.code !== 0) return []
  const parsed = parseJsonOutput(result.stdout)
  if (!Array.isArray(parsed)) return []
  return parsed
    .filter(isJsonObject)
    .flatMap((entry) =>
      typeof entry.name === 'string'
        ? [{ name: entry.name, ...(typeof entry.path === 'string' ? { path: entry.path } : {}) }]
        : [],
    )
}

/** An `agent-peers` marketplace added from another version's folder is removed so the new one can be added. */
async function dropStaleMarketplace(
  ctx: InstallContext,
  claude: string,
  version: string | undefined,
): Promise<readonly CliStep[]> {
  const stale = (await listMarketplaces(ctx, claude)).find(
    (entry) => entry.name === MARKETPLACE_NAME && entry.path !== ctx.layout.claudeMarketplace,
  )
  if (!stale) return []
  const argv = [
    claude,
    'plugin',
    'marketplace',
    'remove',
    MARKETPLACE_NAME,
    ...jsonFlag(version, VERSION_GATES.claudeMarketplaceJson),
  ]
  return [await runCliStep(ctx.sys, argv, { already: NOT_PRESENT })]
}

async function installWithCli(detection: AgentDetection, ctx: InstallContext): Promise<StepOutcome> {
  const claude = detection.binary?.path ?? 'claude'
  const steps: CliStep[] = [...(await dropStaleMarketplace(ctx, claude, detection.version))]
  for (const argv of claudeInstallCommands(claude, detection.version, ctx.layout.claudeMarketplace)) {
    const step = await runCliStep(ctx.sys, argv, { already: ALREADY_INSTALLED })
    steps.push(step)
    if (!step.ok) break
  }
  const ok = steps.every((step) => step.ok)
  const changed = steps.some((step) => step.ok && !step.already)
  return { ok, changed, method: 'marketplace', lines: steps.map(describeStep) }
}

async function install(detection: AgentDetection, ctx: InstallContext): Promise<StepOutcome> {
  if (!detection.binary) return installSkillsDir(ctx)
  const viaCli = await installWithCli(detection, ctx)
  if (!viaCli.ok) {
    const fallback = await installSkillsDir(ctx)
    return {
      ...fallback,
      lines: [...viaCli.lines, 'the plugin CLI failed; falling back to the skills dir', ...fallback.lines],
    }
  }
  // Never load the plugin twice: a skills-dir copy from an earlier fallback goes away.
  const cleanup = await removeSkillsDir(ctx.sys)
  return { ...viaCli, changed: viaCli.changed || cleanup.changed, lines: [...viaCli.lines, ...cleanup.lines] }
}

async function uninstall(detection: AgentDetection, ctx: InstallContext): Promise<StepOutcome> {
  const steps: CliStep[] = []
  const claude = detection.binary?.path
  if (claude) {
    const json = (min: string) => jsonFlag(detection.version, min)
    const commands = [
      [claude, 'plugin', 'uninstall', PLUGIN_ID, '--scope', 'user', ...json(VERSION_GATES.claudeInstallJson)],
      [
        claude,
        'plugin',
        'marketplace',
        'remove',
        MARKETPLACE_NAME,
        ...json(VERSION_GATES.claudeMarketplaceJson),
      ],
    ]
    for (const argv of commands) steps.push(await runCliStep(ctx.sys, argv, { already: NOT_PRESENT }))
  }
  const skills = await removeSkillsDir(ctx.sys)
  return {
    ok: steps.every((step) => step.ok),
    changed: skills.changed || steps.some((step) => step.ok && !step.already),
    lines: [...steps.map(describeStep), ...skills.lines],
  }
}

interface ListedPlugin {
  readonly id: string
  readonly enabled: boolean
  readonly path?: string
  readonly errors: readonly string[]
}

/** `claude plugin list --json` entries for our plugin (`peers@agent-peers` or `peers@skills-dir`). */
async function listedPlugin(ctx: InstallContext, claude: string): Promise<ListedPlugin | undefined> {
  const result = await ctx.sys.run([claude, 'plugin', 'list', '--json'], { timeoutMs: 30_000 })
  const parsed = result.code === 0 ? parseJsonOutput(result.stdout) : undefined
  if (!Array.isArray(parsed)) return undefined
  const ours = parsed
    .filter(isJsonObject)
    .find((entry) => entry.id === PLUGIN_ID || entry.id === `${PLUGIN_NAME}@skills-dir`)
  if (!ours) return undefined
  const path = typeof ours.installPath === 'string' ? ours.installPath : ours.readFromFolder
  return {
    id: String(ours.id),
    enabled: ours.enabled === true,
    ...(typeof path === 'string' ? { path } : {}),
    errors: Array.isArray(ours.errors) ? ours.errors.map(String) : [],
  }
}

async function status(detection: AgentDetection, ctx: InstallContext): Promise<AgentStatus> {
  const listed = detection.binary ? await listedPlugin(ctx, detection.binary.path) : undefined
  if (listed) {
    return {
      installed: true,
      enabled: listed.enabled && listed.errors.length === 0,
      method: listed.id === PLUGIN_ID ? 'marketplace' : 'skills-dir',
      ...(listed.path ? { pluginPath: listed.path } : {}),
      lines: [`${listed.id} ${listed.enabled ? 'enabled' : 'disabled'}`, ...listed.errors],
    }
  }
  if (await hasOurSkillsDir(ctx.sys)) {
    const dir = skillsDirPath(ctx.sys)
    return {
      installed: true,
      enabled: true,
      method: 'skills-dir',
      pluginPath: dir,
      lines: [`skills-dir plugin at ${dir}`],
    }
  }
  return { installed: false, lines: ['plugin peers@agent-peers is not installed'] }
}

function plan(detection: AgentDetection, ctx: InstallContext): readonly string[] {
  if (!detection.binary) return [`copy the plugin to ${skillsDirPath(ctx.sys)} (loads as peers@skills-dir)`]
  return [
    ...claudeInstallCommands(detection.binary.path, detection.version, ctx.layout.claudeMarketplace).map(
      (argv) => `$ ${argv.join(' ')}`,
    ),
    `if that fails: copy the plugin to ${skillsDirPath(ctx.sys)}`,
  ]
}

export const claudeCodeInstaller: Installer = {
  id: 'claude-code',
  finish: (method) =>
    method === 'skills-dir'
      ? 'start a new Claude Code session (skills-dir plugins load only in new sessions), then send any message (e.g. /peers:who)'
      : 'type /reload-plugins --force, then send any message (e.g. /peers:who)',
  plan,
  install,
  uninstall,
  status,
}
