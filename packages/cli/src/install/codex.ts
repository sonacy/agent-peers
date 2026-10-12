/**
 * Codex CLI and Codex desktop (ARCHITECTURE §4): both use Codex's plugin CLI against the shared
 * CODEX_HOME — the CLI with `codex` from PATH, the desktop with its bundled engine — then pre-approve
 * the reply tools in config.toml (after a backup). Hooks still need the user's trust in /hooks.
 */

import { codexConfigPath, readCodexConfig } from '../agents/codex'
import type { AgentDetection, AgentId } from '../agents/types'
import { MARKETPLACE_NAME, PLUGIN_ID } from '../assets/materialize'
import {
  addApprovals,
  type ConfigEdit,
  peersHooksTrusted,
  pluginEnabled,
  removeApprovals,
} from './codex-config'
import { type CliStep, describeStep, runCliStep } from './exec'
import { replaceWithBackup } from './files'
import type { AgentStatus, InstallContext, Installer, StepOutcome } from './types'

const MARKETPLACE_ALREADY = /is already added\.?(?! from)|already added$/im
const DIFFERENT_SOURCE = /already added from|different source/i
const PLUGIN_ALREADY = /already installed|already enabled/i
const NOT_PRESENT = /not installed|not found|no such|unknown|does not exist|is not added/i

export function codexInstallCommands(codex: string, marketplaceDir: string): readonly (readonly string[])[] {
  return [
    [codex, 'plugin', 'marketplace', 'add', marketplaceDir, '--json'],
    [codex, 'plugin', 'add', PLUGIN_ID, '--json'],
  ]
}

/** `marketplace add`; an `agent-peers` marketplace from another folder (older version) is replaced. */
async function addMarketplace(codex: string, ctx: InstallContext): Promise<readonly CliStep[]> {
  const [addArgv] = codexInstallCommands(codex, ctx.layout.codexMarketplace)
  if (!addArgv) return []
  const first = await runCliStep(ctx.sys, addArgv, { already: MARKETPLACE_ALREADY })
  const output = `${first.result.stdout}\n${first.result.stderr}`
  if (first.ok || !DIFFERENT_SOURCE.test(output)) return [first]
  const steps = [
    await runCliStep(ctx.sys, [codex, 'plugin', 'remove', PLUGIN_ID, '--json'], { already: NOT_PRESENT }),
    await runCliStep(ctx.sys, [codex, 'plugin', 'marketplace', 'remove', MARKETPLACE_NAME], {
      already: NOT_PRESENT,
    }),
  ]
  return [...steps, await runCliStep(ctx.sys, addArgv, { already: MARKETPLACE_ALREADY })]
}

/** Applies a pure config.toml edit with a backup. */
async function editConfig(
  ctx: InstallContext,
  edit: (text: string) => ConfigEdit,
): Promise<{ readonly ok: boolean; readonly changed: boolean; readonly lines: readonly string[] }> {
  const path = codexConfigPath(ctx.sys)
  const text = (await ctx.sys.readText(path)) ?? ''
  let result: ConfigEdit
  try {
    result = edit(text)
  } catch (error) {
    return {
      ok: false,
      changed: false,
      lines: [`${path}: ${error instanceof Error ? error.message : error}`],
    }
  }
  const kept = result.kept.map((tool) => `${path}: kept your approval_mode for ${tool}`)
  if (!result.changed) return { ok: true, changed: false, lines: kept }
  const backup = await replaceWithBackup(path, result.text, ctx.sys.now())
  return {
    ok: true,
    changed: true,
    lines: [`updated ${path} (reply tools approval)`, ...(backup ? [`backup ${backup}`] : []), ...kept],
  }
}

async function install(detection: AgentDetection, ctx: InstallContext): Promise<StepOutcome> {
  const codex = detection.binary?.path
  if (!codex) return { ok: false, changed: false, lines: ['no codex binary to install with'] }
  const steps: CliStep[] = [...(await addMarketplace(codex, ctx))]
  const added = steps.at(-1)
  const [, pluginArgv] = codexInstallCommands(codex, ctx.layout.codexMarketplace)
  if (added?.ok && pluginArgv) steps.push(await runCliStep(ctx.sys, pluginArgv, { already: PLUGIN_ALREADY }))
  const cliOk = steps.length > 0 && steps.every((step) => step.ok)
  const config = cliOk ? await editConfig(ctx, addApprovals) : { ok: false, changed: false, lines: [] }
  return {
    ok: cliOk && config.ok,
    changed: steps.some((step) => step.ok && !step.already) || config.changed,
    method: 'marketplace',
    lines: [...steps.map(describeStep), ...config.lines],
  }
}

async function uninstall(detection: AgentDetection, ctx: InstallContext): Promise<StepOutcome> {
  const codex = detection.binary?.path
  const steps: CliStep[] = []
  if (codex) {
    steps.push(
      await runCliStep(ctx.sys, [codex, 'plugin', 'remove', PLUGIN_ID, '--json'], { already: NOT_PRESENT }),
    )
    steps.push(
      await runCliStep(ctx.sys, [codex, 'plugin', 'marketplace', 'remove', MARKETPLACE_NAME], {
        already: NOT_PRESENT,
      }),
    )
  }
  const config = await editConfig(ctx, removeApprovals)
  return {
    ok: steps.every((step) => step.ok) && config.ok,
    changed: steps.some((step) => step.ok && !step.already) || config.changed,
    lines: [...steps.map(describeStep), ...config.lines],
  }
}

async function status(_detection: AgentDetection, ctx: InstallContext): Promise<AgentStatus> {
  const config = await readCodexConfig(ctx.sys)
  if (!config) return { installed: false, lines: [`${codexConfigPath(ctx.sys)}: missing or invalid`] }
  const enabled = pluginEnabled(config)
  if (enabled === undefined) return { installed: false, lines: [`plugin ${PLUGIN_ID} is not installed`] }
  const trusted = peersHooksTrusted(config)
  return {
    installed: true,
    enabled,
    method: 'marketplace',
    hooksTrusted: trusted,
    lines: [
      `plugin ${PLUGIN_ID} ${enabled ? 'enabled' : 'disabled'}`,
      trusted ? 'peers hooks trusted' : 'peers hooks not trusted yet: open /hooks and trust "peers"',
    ],
  }
}

function codexInstaller(id: AgentId, finish: string): Installer {
  return {
    id,
    finish: () => finish,
    plan: (detection, ctx) => [
      ...codexInstallCommands(detection.binary?.path ?? 'codex', ctx.layout.codexMarketplace).map(
        (argv) => `$ ${argv.join(' ')}`,
      ),
      `back up ${codexConfigPath(ctx.sys)}, then set approval_mode = "approve" for peers_reply and peers_progress`,
    ],
    install,
    uninstall,
    status,
  }
}

export const codexCliInstaller = codexInstaller(
  'codex',
  'restart codex (codex resume --last) → open /hooks → trust "peers" → send any message (e.g. $peers:who)',
)

export const codexDesktopInstaller = codexInstaller(
  'codex-desktop',
  'open a new chat → Review hooks → trust "peers" → send any message',
)
