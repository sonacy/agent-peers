/** Per-agent installers (ARCHITECTURE §4 step 3): plan (dry run), install, uninstall, status. */
import type { AgentDetection, AgentId, Sys } from '../agents/types'
import type { PluginLayout } from '../assets/materialize'

export interface InstallContext {
  readonly sys: Sys
  /** The agent-peers home (`~/.agent-peers` or `$AGENT_PEERS_HOME`). */
  readonly home: string
  readonly version: string
  /** `<home>/bin/agent-peers-<version>`: what the plugin shims run. */
  readonly binary: string
  /** `<home>/bin/current`: what Claude Desktop runs (survives upgrades). */
  readonly currentBinary: string
  readonly layout: PluginLayout
}

export interface StepOutcome {
  readonly ok: boolean
  /** Something on disk or in the agent's config changed. */
  readonly changed: boolean
  /** One line per action, already formatted for the terminal. */
  readonly lines: readonly string[]
  /** How it was installed (`marketplace`, `skills-dir`, `config`). */
  readonly method?: string
}

export interface AgentStatus {
  readonly installed: boolean
  readonly enabled?: boolean
  readonly method?: string
  /** Where the agent loads the plugin from, when known. */
  readonly pluginPath?: string
  /** Hook trust, where the agent records it (Codex). Undefined when not applicable or unknown. */
  readonly hooksTrusted?: boolean
  readonly lines: readonly string[]
}

export interface Installer {
  readonly id: AgentId
  /** The `[agent-peers] FINISH:` step for this agent (ONBOARDING §4), never hub text. */
  finish(method?: string): string
  plan(detection: AgentDetection, ctx: InstallContext): readonly string[]
  install(detection: AgentDetection, ctx: InstallContext): Promise<StepOutcome>
  uninstall(detection: AgentDetection, ctx: InstallContext): Promise<StepOutcome>
  status(detection: AgentDetection, ctx: InstallContext): Promise<AgentStatus>
}

export const failed = (lines: readonly string[]): StepOutcome => ({ ok: false, changed: false, lines })
