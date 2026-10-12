/** `agent-peers version`: the CLI, wire protocol and runtime versions. */
import { PROTOCOL_VERSION, SUPPORTED_PROTOCOLS } from '@agent-peers/protocol'
import { type Command, Command as CommanderCommand } from 'commander'
import { globalsOf } from '../globals'
import type { CliIo } from '../io'
import { CLI_VERSION } from '../version'

export interface VersionInfo {
  readonly cli: string
  readonly protocol: string
  readonly supported_protocols: readonly string[]
  readonly bun: string
  readonly platform: string
}

export function versionInfo(): VersionInfo {
  return {
    cli: CLI_VERSION,
    protocol: PROTOCOL_VERSION,
    supported_protocols: SUPPORTED_PROTOCOLS,
    bun: Bun.version,
    platform: `${process.platform}-${process.arch}`,
  }
}

export function versionLines(info: VersionInfo): readonly string[] {
  return [
    `agent-peers ${info.cli}`,
    `protocol    ${info.protocol}`,
    `runtime     bun ${info.bun} (${info.platform})`,
  ]
}

export function versionCommand(io: CliIo, setExit: (code: number) => void): Command {
  return new CommanderCommand('version')
    .description('print the CLI and protocol versions')
    .action((_options: unknown, self: Command) => {
      const info = versionInfo()
      io.stdout(globalsOf(self).json ? `${JSON.stringify(info)}\n` : `${versionLines(info).join('\n')}\n`)
      setExit(0)
    })
}
