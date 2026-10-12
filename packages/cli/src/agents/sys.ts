/** The real `Sys`: file system probes and child processes, scoped to an env (never `process.env` implicitly). */
import { constants } from 'node:fs'
import { access, readdir, readFile, realpath } from 'node:fs/promises'
import { homedir } from 'node:os'
import { delimiter, join } from 'node:path'
import type { EnvLike } from '@agent-peers/core'
import type { RunOptions, RunResult, Sys } from './types'

/** A child that does not answer within this is killed (version probes, plugin CLIs). */
export const DEFAULT_RUN_TIMEOUT_MS = 120_000

/** The env as a plain record without undefined values, for `Bun.spawn`. */
export function spawnEnv(env: EnvLike): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined),
  )
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK)
    return true
  } catch {
    return false
  }
}

async function isExecutable(path: string): Promise<boolean> {
  try {
    await access(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

async function readText(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8')
  } catch {
    return undefined
  }
}

async function listDir(path: string): Promise<readonly string[]> {
  try {
    return await readdir(path)
  } catch {
    return []
  }
}

/** Runs `argv` with `env`; never throws for a missing binary (code 127) or a timeout (code 124). */
export async function runProcess(
  argv: readonly string[],
  env: EnvLike,
  options: RunOptions = {},
): Promise<RunResult> {
  let proc: ReturnType<typeof Bun.spawn>
  try {
    proc = Bun.spawn([...argv], {
      env: spawnEnv(env),
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
      ...(options.cwd ? { cwd: options.cwd } : {}),
    })
  } catch (error) {
    return { code: 127, stdout: '', stderr: String(error), timedOut: false }
  }
  let timer: ReturnType<typeof setTimeout> | undefined
  // A killed child's own children can keep the pipes open: never wait for them after the deadline.
  const deadline = new Promise<RunResult>((resolve) => {
    timer = setTimeout(() => {
      proc.kill('SIGKILL')
      resolve({ code: 124, stdout: '', stderr: 'timed out', timedOut: true })
    }, options.timeoutMs ?? DEFAULT_RUN_TIMEOUT_MS)
  })
  const finished = Promise.all([
    new Response(proc.stdout as ReadableStream<Uint8Array>).text(),
    new Response(proc.stderr as ReadableStream<Uint8Array>).text(),
    proc.exited,
  ]).then(([stdout, stderr, code]): RunResult => ({ code, stdout, stderr, timedOut: false }))
  try {
    return await Promise.race([finished, deadline])
  } finally {
    clearTimeout(timer)
  }
}

/** `$AGENT_PEERS_APP_DIRS` (path-list) for nonstandard locations; else `/Applications` and `~/Applications`. */
export const APP_DIRS_ENV = 'AGENT_PEERS_APP_DIRS'

export function defaultAppDirs(env: EnvLike, home: string, platform: NodeJS.Platform): readonly string[] {
  const override = env[APP_DIRS_ENV]
  if (override !== undefined) return override.split(delimiter).filter((dir) => dir.length > 0)
  return platform === 'darwin' ? ['/Applications', join(home, 'Applications')] : []
}

export interface SysOptions {
  readonly env: EnvLike
  readonly home?: string
  readonly platform?: NodeJS.Platform
  readonly appDirs?: readonly string[]
  readonly now?: () => number
}

export function createSys(options: SysOptions): Sys {
  const home = options.home ?? options.env.HOME ?? homedir()
  const platform = options.platform ?? process.platform
  const appDirs = options.appDirs ?? defaultAppDirs(options.env, home, platform)
  return {
    env: options.env,
    home,
    platform,
    appDirs,
    exists,
    isExecutable,
    readText,
    listDir,
    realpath: (path) => realpath(path).catch(() => path),
    run: (argv, runOptions) => runProcess(argv, options.env, runOptions),
    now: options.now ?? Date.now,
  }
}
