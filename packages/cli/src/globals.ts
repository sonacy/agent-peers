/**
 * Global flags (`--home`, `--json`, `--verbose`). Commands read them with `globalsOf(command)`.
 * `--home` is applied before the command tree is built: it becomes `AGENT_PEERS_HOME` in the
 * command's env, so every module that resolves the home sees it.
 */
import { homedir } from 'node:os'
import { resolve } from 'node:path'
import { HOME_ENV, resolvePeersHome } from '@agent-peers/core'
import type { Command } from 'commander'
import type { CliIo } from './io'

export interface GlobalOptions {
  readonly home?: string
  readonly json?: boolean
  readonly verbose?: boolean
}

export function globalsOf(command: Command): GlobalOptions {
  const all = command.optsWithGlobals<Record<string, unknown>>()
  return {
    ...(typeof all.home === 'string' ? { home: all.home } : {}),
    ...(all.json === true ? { json: true } : {}),
    ...(all.verbose === true ? { verbose: true } : {}),
  }
}

/** The value of `--home <dir>` / `--home=<dir>` (the last one wins), scanning up to `--`. */
export function homeFlag(argv: readonly string[]): string | undefined {
  let found: string | undefined
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] as string
    if (arg === '--') break
    if (arg === '--home' && i + 1 < argv.length) {
      found = argv[i + 1]
      i += 1
    } else if (arg.startsWith('--home=')) {
      found = arg.slice('--home='.length)
    }
  }
  return found === undefined || found.trim() === '' ? undefined : found
}

/** `io` with `AGENT_PEERS_HOME` set to `home` (resolved against cwd); `io` itself when undefined. */
export function withHome(io: CliIo, home: string | undefined): CliIo {
  if (home === undefined) return io
  return { ...io, env: { ...io.env, [HOME_ENV]: resolve(home) } }
}

/** The user's home for `io` ($HOME, as the installer's Sys reads it). */
export function userHomeOf(io: CliIo): string {
  return io.env.HOME ?? homedir()
}

/** The agent-peers home for `io`: `$AGENT_PEERS_HOME` (set by `--home`) or `<user home>/.agent-peers`. */
export function peersHomeOf(io: CliIo, userHome: string = userHomeOf(io)): string {
  return resolvePeersHome(io.env, userHome)
}
