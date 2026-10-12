/** Per-agent installers (ARCHITECTURE §4). */
import type { AgentId } from '../agents/types'
import { claudeCodeInstaller } from './claude-code'
import { claudeDesktopInstaller } from './claude-desktop'
import { codexCliInstaller, codexDesktopInstaller } from './codex'
import type { Installer } from './types'

export const INSTALLERS: Readonly<Record<AgentId, Installer>> = {
  'claude-code': claudeCodeInstaller,
  'claude-desktop': claudeDesktopInstaller,
  codex: codexCliInstaller,
  'codex-desktop': codexDesktopInstaller,
}

export const installerFor = (id: AgentId): Installer => INSTALLERS[id]

/** Agents that share one plugin install (Codex CLI and desktop share CODEX_HOME). */
export const SHARED_INSTALL: Readonly<Partial<Record<AgentId, AgentId>>> = {
  codex: 'codex-desktop',
  'codex-desktop': 'codex',
}

export type { Prepared, SelftestResult } from './prepare'
export { installContext, prepareInstall, SELFTEST_TIMEOUT_MS, selftest } from './prepare'
export type { InstallRecord, InstallState } from './state'
export {
  installedIds,
  installStatePath,
  readInstallState,
  withoutRecord,
  withRecord,
  writeInstallState,
} from './state'
export type { AgentStatus, InstallContext, Installer, StepOutcome } from './types'
