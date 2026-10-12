/** Agent detection (ARCHITECTURE §4 step 1). */
export type { AppBundle, Candidate } from './binaries'
export { findApp, isWrapperShim, pathCandidates, plistValue, readVersion, resolveBinary } from './binaries'
export {
  CLAUDE_DESKTOP_CONFIG_FILE,
  claudeConfigDir,
  claudeDesktopConfigDir,
  detectClaudeCode,
  detectClaudeDesktop,
} from './claude'
export {
  CODEX_BUNDLED_ENGINE,
  codexConfigPath,
  codexHome,
  detectCodex,
  detectCodexDesktop,
  findCodexCliPath,
  readCodexConfig,
} from './codex'
export type { CurrentAgent, DetectedAgentResult, DetermineAgent } from './current'
export { detectCurrentAgent } from './current'
export type { AgentEntry } from './registry'
export { AGENTS, detectAll } from './registry'
export type { SysOptions } from './sys'
export { createSys, runProcess, spawnEnv } from './sys'
export type { AgentDetection, AgentId, FoundBinary, RunOptions, RunResult, Sys } from './types'
export { AGENT_IDS, isAgentId } from './types'
export { atLeast, compareVersions, parseVersion, VERSION_GATES } from './version'
