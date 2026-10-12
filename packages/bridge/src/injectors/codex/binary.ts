/**
 * Finds the Codex CLI that can talk to the shared app-server (`codex queue`), and checks its version.
 * Candidates (ARCHITECTURE §4, §6.1; verified research):
 * - `CODEX_CLI_PATH` from the environment (the desktop app sets it for its app-server's children);
 * - `CODEX_CLI_PATH` anywhere in `$CODEX_HOME/config.toml` (the desktop app writes it, e.g. under
 *   `[mcp_servers.node_repl.env]`);
 * - the ChatGPT.app bundle;
 * - `codex` on PATH.
 * Codex desktop prefers the bundle over config.toml; both are normally the same binary.
 */
import { access, constants, readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { EnvLike } from '@agent-peers/core'
import type { ProcessRunner } from './process'

export const CODEX_BUNDLE_PATHS: readonly string[] = [
  '/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex',
  '/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex',
]

/** `codex queue` exists from 0.149; immediate delivery needs daemon auto-start (0.157, #47179). */
export const MIN_QUEUE_VERSION = '0.157.0'

export type BinarySource = 'env' | 'config' | 'bundle' | 'path'
export type BinaryPreference = 'cli' | 'desktop'

export interface CodexBinary {
  readonly path: string
  readonly source: BinarySource
}

export interface ResolveOptions {
  readonly env: EnvLike
  readonly prefer: BinaryPreference
  readonly bundlePaths?: readonly string[]
  readonly userHome?: string
}

const CONFIG_KEY = 'CODEX_CLI_PATH'
const MAX_TOML_DEPTH = 8

async function isExecutable(path: string): Promise<boolean> {
  try {
    await access(path, constants.X_OK)
    return (await stat(path)).isFile()
  } catch {
    return false
  }
}

/** First `CODEX_CLI_PATH` string in a parsed TOML document: a table's own keys before its subtables. */
export function findConfigPath(doc: unknown, depth = 0): string | undefined {
  if (typeof doc !== 'object' || doc === null || depth > MAX_TOML_DEPTH) return undefined
  const entries = Object.entries(doc as Record<string, unknown>)
  const direct = entries.find(([key, value]) => key === CONFIG_KEY && typeof value === 'string')
  if (direct) return direct[1] as string
  for (const [, value] of entries) {
    const nested = findConfigPath(value, depth + 1)
    if (nested !== undefined) return nested
  }
  return undefined
}

/** `CODEX_CLI_PATH` from `$CODEX_HOME/config.toml`; undefined when missing or unreadable. */
export async function configCodexPath(
  env: EnvLike,
  userHome: string = homedir(),
): Promise<string | undefined> {
  const codexHome = env.CODEX_HOME?.trim() || join(userHome, '.codex')
  let text: string
  try {
    text = await readFile(join(codexHome, 'config.toml'), 'utf8')
  } catch {
    return undefined
  }
  try {
    return findConfigPath(Bun.TOML.parse(text))
  } catch {
    return undefined
  }
}

type Candidate = () => Promise<string | undefined>

export async function resolveCodexBinary(options: ResolveOptions): Promise<CodexBinary | undefined> {
  const bundles = options.bundlePaths ?? CODEX_BUNDLE_PATHS
  const sources: Record<BinarySource, Candidate> = {
    env: async () => options.env.CODEX_CLI_PATH?.trim() || undefined,
    config: () => configCodexPath(options.env, options.userHome),
    bundle: async () => {
      for (const path of bundles) if (await isExecutable(path)) return path
      return undefined
    },
    path: async () => Bun.which('codex', { PATH: options.env.PATH ?? '' }) ?? undefined,
  }
  const order: readonly BinarySource[] =
    options.prefer === 'desktop' ? ['env', 'bundle', 'config', 'path'] : ['env', 'config', 'bundle', 'path']
  for (const source of order) {
    const path = await sources[source]()
    if (path !== undefined && (await isExecutable(path))) return { path, source }
  }
  return undefined
}

/** `codex-cli 0.160.1` → `[0, 160, 1]`; undefined when no version is printed. */
export function parseVersion(text: string): readonly [number, number, number] | undefined {
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(text)
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : undefined
}

export function versionAtLeast(version: readonly number[], minimum: readonly number[]): boolean {
  for (let i = 0; i < 3; i += 1) {
    const a = version[i] ?? 0
    const b = minimum[i] ?? 0
    if (a !== b) return a > b
  }
  return true
}

export interface VersionCheck {
  readonly ok: boolean
  readonly version?: string
  readonly reason?: string
}

export async function checkQueueVersion(
  binary: CodexBinary,
  run: ProcessRunner,
  env: EnvLike,
  minimum: string = MIN_QUEUE_VERSION,
): Promise<VersionCheck> {
  const result = await run([binary.path, '--version'], { env, timeoutMs: 5000 })
  const version = result.exitCode === 0 ? parseVersion(result.stdout) : undefined
  if (version === undefined) return { ok: false, reason: `${binary.path} --version gave no version` }
  const text = version.join('.')
  const min = parseVersion(minimum) ?? [0, 0, 0]
  return versionAtLeast(version, min)
    ? { ok: true, version: text }
    : { ok: false, version: text, reason: `codex ${text} is older than ${minimum}` }
}
