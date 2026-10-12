/**
 * Codex CLI and Codex desktop detection (ARCHITECTURE §4, research: codex-cli 0.160.1, ChatGPT.app
 * bundle id com.openai.codex with the engine under Contents/Resources/codex-cli).
 */
import { join } from 'node:path'
import { expandHome } from '@agent-peers/core'
import { parse, type TomlTable } from 'smol-toml'
import { type Candidate, findApp, pathCandidates, resolveBinary } from './binaries'
import type { AgentDetection, FoundBinary, Sys } from './types'
import { atLeast, VERSION_GATES } from './version'

export const CODEX_DESKTOP_BUNDLE_ID = 'com.openai.codex'
/** The desktop app ships as ChatGPT.app (Codex mode); older installs are a standalone Codex.app. */
export const CODEX_DESKTOP_APP_NAMES = ['ChatGPT.app', 'Codex.app'] as const
/** The bundled engine, relative to the app bundle. */
export const CODEX_BUNDLED_ENGINE = join('Contents', 'Resources', 'codex-cli', 'bin', 'codex')

/** `$CODEX_HOME`, else `~/.codex`. */
export function codexHome(sys: Sys): string {
  const override = sys.env.CODEX_HOME?.trim()
  return override ? expandHome(override, sys.home) : join(sys.home, '.codex')
}

export const codexConfigPath = (sys: Sys): string => join(codexHome(sys), 'config.toml')

/** `$CODEX_HOME/config.toml` parsed; undefined when missing or invalid. */
export async function readCodexConfig(sys: Sys): Promise<TomlTable | undefined> {
  const text = await sys.readText(codexConfigPath(sys))
  if (text === undefined) return undefined
  try {
    return parse(text)
  } catch {
    return undefined
  }
}

const isTable = (value: unknown): value is TomlTable =>
  typeof value === 'object' && value !== null && !Array.isArray(value) && !(value instanceof Date)

/** The desktop app writes `CODEX_CLI_PATH` into an env table of config.toml; found at any depth. */
export function findCodexCliPath(table: TomlTable, depth = 0): string | undefined {
  if (depth > 8) return undefined
  const direct = table.CODEX_CLI_PATH
  if (typeof direct === 'string' && direct.trim()) return direct.trim()
  for (const value of Object.values(table)) {
    if (!isTable(value)) continue
    const nested = findCodexCliPath(value, depth + 1)
    if (nested) return nested
  }
  return undefined
}

export const codexGateReason = (label: string, version: string | undefined): string =>
  `${label} ${version ?? '(unknown version)'} is too old (needs ${VERSION_GATES.codexMin}+ for plugin hooks and push)`

export async function detectCodex(sys: Sys): Promise<AgentDetection> {
  const configDir = codexHome(sys)
  const hasConfig = await sys.exists(configDir)
  const { binary, skipped } = await resolveBinary(sys, await pathCandidates(sys, 'codex'))
  const evidence = [
    ...(binary ? [`codex ${binary.version} at ${binary.path}`] : []),
    ...(hasConfig ? [`CODEX_HOME ${configDir}`] : []),
    ...skipped.map((line) => `skipped ${line}`),
  ]
  const base = {
    id: 'codex' as const,
    label: 'Codex CLI',
    configDir,
    evidence,
    notes: [] as readonly string[],
    ...(binary ? { binary, ...(binary.version ? { version: binary.version } : {}) } : {}),
  }
  if (!binary) {
    // Only a shim (or nothing) on PATH: the CLI is not really installed.
    return {
      ...base,
      detected: skipped.length > 0,
      supported: false,
      reason: 'codex CLI not found on PATH',
    }
  }
  const supported = atLeast(binary.version, VERSION_GATES.codexMin)
  return {
    ...base,
    detected: true,
    supported,
    ...(supported ? {} : { reason: codexGateReason('Codex CLI', binary.version) }),
  }
}

/** Engine candidates: explicit env, the app's bundled engine, then the path the app saved in config.toml. */
async function engineCandidates(sys: Sys, app: string | undefined): Promise<readonly Candidate[]> {
  const fromEnv = sys.env.CODEX_CLI_PATH?.trim()
  const config = await readCodexConfig(sys)
  const fromConfig = config ? findCodexCliPath(config) : undefined
  return [
    ...(fromEnv ? [{ path: fromEnv, source: 'CODEX_CLI_PATH' }] : []),
    ...(app ? [{ path: join(app, CODEX_BUNDLED_ENGINE), source: 'app bundle' }] : []),
    ...(fromConfig ? [{ path: fromConfig, source: 'config.toml CODEX_CLI_PATH' }] : []),
  ]
}

function desktopVerdict(
  app: string | undefined,
  engine: FoundBinary | undefined,
): { readonly detected: boolean; readonly supported: boolean; readonly reason?: string } {
  const detected = app !== undefined || /\.app[/\\]/.test(engine?.path ?? '')
  if (!detected) return { detected, supported: false, reason: 'Codex desktop (ChatGPT.app) not found' }
  if (!engine) return { detected, supported: false, reason: 'the bundled Codex engine was not found' }
  if (!atLeast(engine.version, VERSION_GATES.codexMin))
    return { detected, supported: false, reason: codexGateReason('Codex desktop engine', engine.version) }
  return { detected, supported: true }
}

export async function detectCodexDesktop(sys: Sys): Promise<AgentDetection> {
  const configDir = codexHome(sys)
  const app = await findApp(sys, CODEX_DESKTOP_APP_NAMES, CODEX_DESKTOP_BUNDLE_ID)
  const { binary: engine, skipped } = await resolveBinary(sys, await engineCandidates(sys, app?.path))
  const verdict = desktopVerdict(app?.path, engine)
  return {
    id: 'codex-desktop',
    label: 'Codex desktop',
    ...verdict,
    configDir,
    ...(app ? { app: app.path } : {}),
    ...(app?.version ? { version: app.version } : {}),
    ...(engine ? { binary: engine, ...(engine.version ? { engineVersion: engine.version } : {}) } : {}),
    evidence: [
      ...(app ? [`app ${app.path}${app.version ? ` (${app.version})` : ''}`] : []),
      ...(engine ? [`engine codex ${engine.version} at ${engine.path} (${engine.source})`] : []),
      ...skipped.map((line) => `skipped ${line}`),
    ],
    notes: ['shares CODEX_HOME with the Codex CLI; push only reaches threads loaded in the app'],
  }
}
