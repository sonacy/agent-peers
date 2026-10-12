/**
 * The sandbox stop of `join` (ONBOARDING §3 step 2): exit 3 with the exact command to rerun with
 * escalation, and the equivalent terminal command (same flags, the agent's `--session-key`, run in
 * the agent's workspace). Every value is shell-quoted, the hub URL included: it comes from an
 * untrusted invite link. A plain-http hub's `/install.sh` (LAN, tailnet, `--insecure`) is never
 * piped into `sh`, since anyone on the path could swap it: the GitHub Releases installer pinned to
 * this version (https only) is printed instead. Loopback is the exception: it never leaves the box.
 */
import { isLoopbackHost } from '@agent-peers/protocol'
import { EXIT } from '../errors'
import { CLI_VERSION } from '../version'
import type { StopReport } from './errors'
import type { JoinOptions } from './types'

/** The GitHub repository whose releases install.sh downloads (matches the hub's default). */
export const RELEASE_REPO = 'sonacy/agent-peers'

export interface SandboxCommand {
  readonly origin: string
  /** `join <url> …` arguments as the agent should rerun them (escalated). */
  readonly args: readonly string[]
  /** The same join for a terminal, naming the agent and its session key. */
  readonly terminalArgs: readonly string[]
  /** The agent's working directory: the terminal command `cd`s there first. */
  readonly workspace?: string
  /** The release to install when the hub is not https (default: this CLI's version). */
  readonly version?: string
}

/** What the sandbox command needs from the join setup (no preview, no network). */
export interface SandboxSource {
  readonly invite: { readonly url: string; readonly origin: string }
  readonly agent: { readonly ids: readonly string[] }
  readonly workspace: string
}

/** POSIX shell quoting: safe words as they are, everything else single-quoted. */
export const shellQuote = (arg: string): string =>
  /^[\w@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, `'\\''`)}'`

/** https, or plain http that never leaves this machine (loopback): safe to pipe into `sh`. */
export function trustedInstallOrigin(origin: string): boolean {
  try {
    const url = new URL(origin)
    return url.protocol === 'https:' || (url.protocol === 'http:' && isLoopbackHost(url.hostname))
  } catch {
    return false
  }
}

/** `curl … | sh -s -- <args>`: the hub's own installer when trusted, else GitHub's, pinned. */
export function installCommand(origin: string, args: readonly string[], version = CLI_VERSION): string {
  const tail = args.map(shellQuote).join(' ')
  if (trustedInstallOrigin(origin))
    return `curl -fsSL ${shellQuote(`${origin}/install.sh`)} | sh -s -- ${tail}`
  const url = `https://github.com/${RELEASE_REPO}/releases/download/v${shellQuote(version)}/install.sh`
  return `curl --proto '=https' --tlsv1.2 -fsSL ${url} | sh -s -- --version ${shellQuote(version)} ${tail}`
}

/** The flags every rerun keeps. */
function commonArgs(options: JoinOptions): readonly string[] {
  return [
    ...(options.handle ? ['--handle', options.handle] : []),
    ...(options.name ? ['--name', options.name] : []),
    ...(options.summary ? ['--summary', options.summary] : []),
    ...(options.remember ? ['--remember', options.remember] : []),
    ...(options.insecure ? ['--insecure'] : []),
  ]
}

/** The `join` arguments to rerun, as given (escalated) and for a terminal (agent + session key). */
export function sandboxCommand(source: SandboxSource, options: JoinOptions, key: string): SandboxCommand {
  const common = commonArgs(options)
  const agents = source.agent.ids.flatMap((id) => ['-a', id])
  const asGiven = options.here ? ['--here'] : agents
  const keyArgs = options.sessionKey ? ['--session-key', options.sessionKey] : []
  const terminalKey = key ? ['--session-key', key] : []
  return {
    origin: source.invite.origin,
    args: ['join', source.invite.url, ...asGiven, ...keyArgs, ...common],
    terminalArgs: ['join', source.invite.url, ...agents, ...terminalKey, ...common],
    workspace: source.workspace,
  }
}

export function sandboxReport(reason: string, command: SandboxCommand): StopReport {
  const cd = command.workspace ? `cd ${shellQuote(command.workspace)} && ` : ''
  const plainHttp = trustedInstallOrigin(command.origin)
    ? []
    : ['(the hub is plain http://, so the installer comes from GitHub Releases over https)']
  return {
    code: EXIT.sandbox,
    lines: [
      `agent-peers: blocked by your agent's sandbox (${reason}).`,
      'Nothing was redeemed. Rerun this command with escalated/unsandboxed execution (it needs network',
      'access and writes to ~/.agent-peers and your agent config):',
      `  ${installCommand(command.origin, command.args, command.version)}`,
      'Or run the equivalent in a terminal:',
      `  ${cd}${installCommand(command.origin, command.terminalArgs, command.version)}`,
      ...plainHttp,
    ],
  }
}
