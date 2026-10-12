/** Claude Code and Claude Desktop detection (ARCHITECTURE §4, research: Claude Code 2.1.296, Desktop 2.31). */
import { join } from 'node:path'
import { expandHome } from '@agent-peers/core'
import { type Candidate, findApp, pathCandidates, resolveBinary } from './binaries'
import type { AgentDetection, Sys } from './types'
import { atLeast, compareVersions, VERSION_GATES } from './version'

export const CLAUDE_DESKTOP_BUNDLE_ID = 'com.anthropic.claudefordesktop'
export const CLAUDE_DESKTOP_CONFIG_FILE = 'claude_desktop_config.json'

/** `$CLAUDE_CONFIG_DIR`, else `~/.claude`. */
export function claudeConfigDir(sys: Sys): string {
  const override = sys.env.CLAUDE_CONFIG_DIR?.trim()
  return override ? expandHome(override, sys.home) : join(sys.home, '.claude')
}

/** Native installs keep every version under `~/.local/share/claude/versions/<v>`; newest first. */
async function versionedInstalls(sys: Sys): Promise<readonly Candidate[]> {
  const dir = join(sys.home, '.local', 'share', 'claude', 'versions')
  const names = [...(await sys.listDir(dir))].sort((a, b) => compareVersions(b, a))
  return names.map((name) => ({ path: join(dir, name), source: 'versions dir' }))
}

/** The running binary first (inside a session), then PATH, then the native installer's locations. */
async function claudeCandidates(sys: Sys): Promise<readonly Candidate[]> {
  const running = sys.env.CLAUDE_CODE_EXECPATH?.trim()
  return [
    ...(running ? [{ path: running, source: 'CLAUDE_CODE_EXECPATH' }] : []),
    ...(await pathCandidates(sys, 'claude')),
    { path: join(sys.home, '.local', 'bin', 'claude'), source: 'native install' },
    { path: join(sys.home, '.claude', 'local', 'claude'), source: 'local install' },
    ...(await versionedInstalls(sys)),
  ]
}

export async function detectClaudeCode(sys: Sys): Promise<AgentDetection> {
  const configDir = claudeConfigDir(sys)
  const hasConfig = await sys.exists(configDir)
  const { binary, skipped } = await resolveBinary(sys, await claudeCandidates(sys))
  const evidence = [
    ...(binary ? [`claude ${binary.version} at ${binary.path} (${binary.source})`] : []),
    ...(hasConfig ? [`config dir ${configDir}`] : []),
    ...skipped.map((line) => `skipped ${line}`),
  ]
  const base = {
    id: 'claude-code' as const,
    label: 'Claude Code',
    configDir,
    evidence,
    notes: [] as readonly string[],
    ...(binary ? { binary, ...(binary.version ? { version: binary.version } : {}) } : {}),
  }
  if (!binary) {
    // Without the CLI the plugin can still be dropped into the skills dir (loads as peers@skills-dir).
    return hasConfig
      ? {
          ...base,
          detected: true,
          supported: true,
          notes: ['claude CLI not found: installing as a skills-dir plugin'],
        }
      : { ...base, detected: skipped.length > 0, supported: false, reason: 'claude CLI not found' }
  }
  if (!atLeast(binary.version, VERSION_GATES.claudeMin)) {
    return {
      ...base,
      detected: true,
      supported: false,
      reason: `Claude Code ${binary.version} is too old (needs ${VERSION_GATES.claudeMin}+)`,
    }
  }
  return { ...base, detected: true, supported: true }
}

/** Where Claude Desktop keeps `claude_desktop_config.json`, per platform. */
export function claudeDesktopConfigDir(sys: Sys): string {
  if (sys.platform === 'darwin') return join(sys.home, 'Library', 'Application Support', 'Claude')
  if (sys.platform === 'win32') {
    const appData = sys.env.APPDATA?.trim() || join(sys.home, 'AppData', 'Roaming')
    return join(appData, 'Claude')
  }
  const xdg = sys.env.XDG_CONFIG_HOME?.trim()
  return join(xdg ? expandHome(xdg, sys.home) : join(sys.home, '.config'), 'Claude')
}

export async function detectClaudeDesktop(sys: Sys): Promise<AgentDetection> {
  const configDir = claudeDesktopConfigDir(sys)
  const hasConfig = await sys.exists(configDir)
  const app = await findApp(sys, ['Claude.app'], CLAUDE_DESKTOP_BUNDLE_ID)
  const detected = app !== undefined || hasConfig
  const evidence = [
    ...(app ? [`app ${app.path}${app.version ? ` (${app.version})` : ''}`] : []),
    ...(hasConfig ? [`config dir ${configDir}`] : []),
  ]
  return {
    id: 'claude-desktop',
    label: 'Claude Desktop',
    detected,
    supported: detected,
    ...(detected ? {} : { reason: 'Claude Desktop not found' }),
    configDir,
    ...(app ? { app: app.path } : {}),
    ...(app?.version ? { version: app.version } : {}),
    evidence,
    notes: ['poll tier: no hooks in Claude Desktop chat; peers_inbox is checked each turn'],
  }
}
