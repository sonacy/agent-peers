/** @agent-peers/cli: the `agent-peers` binary's command tree. */
export const PACKAGE_NAME = '@agent-peers/cli'

export type { HookCommandDeps, HookCommandOptions } from './commands/hook'
export { hookCommand, runHookCommand } from './commands/hook'
export type { McpCommandDeps, McpCommandOptions } from './commands/mcp'
export { mcpCommand, runMcpCommand } from './commands/mcp'
export type { CliIo } from './io'
export { processIo, readStream } from './io'
export type { ExitCode, ProgramDeps } from './program'
export { buildProgram, main } from './program'
export { CLI_VERSION } from './version'
