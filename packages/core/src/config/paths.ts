/**
 * The local agent-peers home (ARCHITECTURE §5, §8): `~/.agent-peers`, or `$AGENT_PEERS_HOME`.
 * Directories are 0700 and files 0600.
 */
import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'

export const HOME_ENV = 'AGENT_PEERS_HOME'
export const HOME_DIR_NAME = '.agent-peers'
export const DIR_MODE = 0o700
export const FILE_MODE = 0o600

export interface PeersPaths {
  readonly root: string
  readonly config: string
  readonly credentials: string
  readonly autojoin: string
  /** Control sockets and their info files (ARCHITECTURE §5). */
  readonly run: string
  /** Inbox journals (PROTOCOL §6.3). */
  readonly inbox: string
  readonly bin: string
}

export type EnvLike = Readonly<Record<string, string | undefined>>

/** Expands a leading `~` against `userHome`. */
export function expandHome(path: string, userHome: string = homedir()): string {
  if (path === '~') return userHome
  if (path.startsWith('~/')) return join(userHome, path.slice(2))
  return path
}

/**
 * `$AGENT_PEERS_HOME` when set (a leading `~` is expanded, relative paths resolve against cwd),
 * otherwise `<home>/.agent-peers`.
 */
export function resolvePeersHome(env: EnvLike = process.env, userHome: string = homedir()): string {
  const override = env[HOME_ENV]?.trim()
  if (override) {
    const expanded = expandHome(override, userHome)
    return isAbsolute(expanded) ? expanded : resolve(expanded)
  }
  return join(userHome, HOME_DIR_NAME)
}

export function peersPaths(root: string): PeersPaths {
  return Object.freeze({
    root,
    config: join(root, 'config.json'),
    credentials: join(root, 'credentials.json'),
    autojoin: join(root, 'autojoin.json'),
    run: join(root, 'run'),
    inbox: join(root, 'inbox'),
    bin: join(root, 'bin'),
  })
}

/** `run/<bridge_pid>.sock` */
export function socketPathFor(runDir: string, pid: number): string {
  return join(runDir, `${pid}.sock`)
}

/** `run/<bridge_pid>.json` */
export function infoPathFor(runDir: string, pid: number): string {
  return join(runDir, `${pid}.json`)
}

/** Parses `<pid>.json` / `<pid>.sock` file names; undefined for anything else. */
export function pidFromRunFile(name: string, ext: '.json' | '.sock'): number | undefined {
  if (!name.endsWith(ext)) return undefined
  const stem = name.slice(0, -ext.length)
  if (!/^[1-9][0-9]{0,9}$/.test(stem)) return undefined
  return Number(stem)
}
