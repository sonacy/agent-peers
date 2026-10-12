/**
 * Claude Desktop (ARCHITECTURE §4, §6.1 poll tier): one `mcpServers["agent-peers-desktop"]` entry in
 * claude_desktop_config.json, merged with every other key preserved, after a backup.
 */
import { join } from 'node:path'
import {
  desktopServerEntry,
  formatJson,
  mergeDesktopConfig,
  removeDesktopServer,
} from '../../../../adapters/claude-desktop'
import { DESKTOP_SERVER_NAME } from '../../../../adapters/tools'
import { CLAUDE_DESKTOP_CONFIG_FILE } from '../agents/claude'
import type { AgentDetection } from '../agents/types'
import { isJsonObject } from './exec'
import { replaceWithBackup } from './files'
import { type AgentStatus, failed, type InstallContext, type Installer, type StepOutcome } from './types'

export const desktopConfigPath = (detection: AgentDetection): string =>
  join(detection.configDir, CLAUDE_DESKTOP_CONFIG_FILE)

type Loaded = { readonly ok: true; readonly config: unknown } | { readonly ok: false; readonly error: string }

/** The current config: undefined when the file is missing; an error for invalid JSON (never overwritten). */
async function loadConfig(ctx: InstallContext, path: string): Promise<Loaded> {
  const text = await ctx.sys.readText(path)
  if (text === undefined || text.trim() === '') return { ok: true, config: undefined }
  try {
    return { ok: true, config: JSON.parse(text) as unknown }
  } catch (error) {
    return { ok: false, error: `${path} is not valid JSON (${String(error)}); fix or move it, then rerun` }
  }
}

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b)

async function writeConfig(
  ctx: InstallContext,
  path: string,
  next: unknown,
  verb: string,
): Promise<StepOutcome> {
  const backup = await replaceWithBackup(path, formatJson(next), ctx.sys.now())
  return {
    ok: true,
    changed: true,
    method: 'config',
    lines: [`${verb} ${path}`, ...(backup ? [`backup ${backup}`] : [])],
  }
}

async function install(detection: AgentDetection, ctx: InstallContext): Promise<StepOutcome> {
  const path = desktopConfigPath(detection)
  const loaded = await loadConfig(ctx, path)
  if (!loaded.ok) return failed([loaded.error])
  let next: unknown
  try {
    next = mergeDesktopConfig(loaded.config, ctx.currentBinary)
  } catch (error) {
    return failed([`${path}: ${error instanceof Error ? error.message : String(error)}`])
  }
  if (same(loaded.config, next))
    return { ok: true, changed: false, method: 'config', lines: [`${path}: already configured`] }
  return writeConfig(ctx, path, next, `added mcpServers["${DESKTOP_SERVER_NAME}"] to`)
}

async function uninstall(detection: AgentDetection, ctx: InstallContext): Promise<StepOutcome> {
  const path = desktopConfigPath(detection)
  const loaded = await loadConfig(ctx, path)
  if (!loaded.ok) return failed([loaded.error])
  if (loaded.config === undefined) return { ok: true, changed: false, lines: [`${path}: nothing to remove`] }
  let next: unknown
  try {
    next = removeDesktopServer(loaded.config)
  } catch (error) {
    return failed([`${path}: ${error instanceof Error ? error.message : String(error)}`])
  }
  if (same(loaded.config, next)) return { ok: true, changed: false, lines: [`${path}: nothing to remove`] }
  return writeConfig(ctx, path, next, `removed mcpServers["${DESKTOP_SERVER_NAME}"] from`)
}

async function status(detection: AgentDetection, ctx: InstallContext): Promise<AgentStatus> {
  const path = desktopConfigPath(detection)
  const loaded = await loadConfig(ctx, path)
  if (!loaded.ok) return { installed: false, lines: [loaded.error] }
  const servers = isJsonObject(loaded.config) ? loaded.config.mcpServers : undefined
  const entry = isJsonObject(servers) ? servers[DESKTOP_SERVER_NAME] : undefined
  if (!isJsonObject(entry))
    return { installed: false, lines: [`${path}: no "${DESKTOP_SERVER_NAME}" server`] }
  const command = typeof entry.command === 'string' ? entry.command : ''
  const runnable = command !== '' && (await ctx.sys.isExecutable(command))
  const expected = same(entry.args, desktopServerEntry(ctx.currentBinary).args)
  return {
    installed: true,
    enabled: runnable && expected,
    method: 'config',
    pluginPath: path,
    lines: [
      `${path}: "${DESKTOP_SERVER_NAME}" runs ${command || '(no command)'}`,
      ...(runnable ? [] : [`${command || 'the command'} is not an executable file`]),
      ...(expected ? [] : ['unexpected args (rerun agent-peers add -a claude-desktop)']),
    ],
  }
}

export const claudeDesktopInstaller: Installer = {
  id: 'claude-desktop',
  finish: () => 'quit and reopen Claude, then set agent-peers tools to "Always allow"',
  plan: (detection, ctx) => [
    `back up ${desktopConfigPath(detection)}, then merge mcpServers["${DESKTOP_SERVER_NAME}"] = ` +
      `{ command: ${ctx.currentBinary}, args: [mcp, --surface, claude-desktop] }`,
  ],
  install,
  uninstall,
  status,
}
