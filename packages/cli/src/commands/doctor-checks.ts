/**
 * `doctor` checks (ARCHITECTURE §4): detection and versions, plugin enabled, hooks trusted, MCP
 * selftest, a synthetic hook → bridge round-trip, the peer-turn gate, and hub reachability (TLS).
 */
import { join } from 'node:path'
import { callControl, hubOrigin, isPrivateHost, LocalHome, listBridges } from '@agent-peers/core'
import { codexHome } from '../agents/codex'
import { AGENTS } from '../agents/registry'
import type { AgentDetection, AgentId, Sys } from '../agents/types'
import { isJsonObject, parseJsonOutput } from '../install/exec'
import {
  type AgentStatus,
  type InstallContext,
  type InstallState,
  installerFor,
  selftest,
} from '../install/index'

export type CheckStatus = 'ok' | 'warn' | 'fail' | 'skip'

export interface Check {
  readonly id: string
  readonly agent?: AgentId
  readonly status: CheckStatus
  readonly summary: string
}

const check = (id: string, status: CheckStatus, summary: string, agent?: AgentId): Check => ({
  id,
  status,
  summary,
  ...(agent ? { agent } : {}),
})

/** The installed binary answers `--version`. */
export async function checkBinary(ctx: InstallContext): Promise<Check> {
  const path = ctx.currentBinary
  if (!(await ctx.sys.isExecutable(path)))
    return check('binary', 'fail', `${path} missing: run agent-peers add`)
  const result = await ctx.sys.run([path, '--version'], { timeoutMs: 10_000 })
  if (result.code !== 0) return check('binary', 'fail', `${path} --version failed (exit ${result.code})`)
  return check('binary', 'ok', `${path} (${result.stdout.trim() || 'unknown version'})`)
}

export function checkDetection(detection: AgentDetection, recorded: boolean): Check {
  const version = [detection.version, detection.engineVersion && `engine ${detection.engineVersion}`]
    .filter(Boolean)
    .join(', ')
  const where = detection.binary?.path ?? detection.app ?? detection.configDir
  if (detection.supported) return check('detect', 'ok', `${version || 'found'} at ${where}`, detection.id)
  const reason = detection.reason ?? 'not found'
  return check('detect', recorded ? 'fail' : detection.detected ? 'warn' : 'skip', reason, detection.id)
}

export function checkPlugin(id: AgentId, status: AgentStatus, recorded: boolean): Check {
  const detail = status.lines[0] ?? ''
  if (!status.installed) {
    return recorded
      ? check('plugin', 'fail', `${detail} (rerun agent-peers add -a ${id})`, id)
      : check('plugin', 'skip', `not installed (agent-peers add -a ${id})`, id)
  }
  if (status.enabled === false) return check('plugin', 'fail', status.lines.join('; '), id)
  return check('plugin', 'ok', detail, id)
}

/** Codex records hook trust per hash in config.toml; Claude Code trusts plugin hooks on install. */
export function checkHooks(id: AgentId, status: AgentStatus): Check | undefined {
  if (!status.installed || status.hooksTrusted === undefined) return undefined
  if (status.hooksTrusted) return check('hooks', 'ok', 'peers hooks trusted', id)
  const where = id === 'codex-desktop' ? 'open a new chat → Review hooks' : 'open /hooks in codex'
  return check('hooks', 'warn', `peers hooks not trusted: ${where} and trust "peers"`, id)
}

async function readJson(sys: Sys, path: string): Promise<unknown> {
  const text = await sys.readText(path)
  return text === undefined ? undefined : parseJsonOutput(text)
}

/** Does a hooks object declare a PreToolUse handler? (`{hooks: {PreToolUse: [...]}}`) */
const hasPreToolUse = (value: unknown): boolean => {
  const hooks = isJsonObject(value) ? value.hooks : undefined
  return isJsonObject(hooks) && Array.isArray(hooks.PreToolUse) && hooks.PreToolUse.length > 0
}

/** The installed Codex plugin root: Codex's cache copy when present, else our materialized tree. */
async function codexPluginRoot(ctx: InstallContext): Promise<string> {
  const cache = join(codexHome(ctx.sys), 'plugins', 'cache', 'agent-peers', 'peers')
  const versions = await ctx.sys.listDir(cache)
  const latest = [...versions].sort().at(-1)
  return latest ? join(cache, latest) : ctx.layout.codexPlugin
}

/** The plugin tree the agent loads registers the PreToolUse gate (ARCHITECTURE §8). */
export async function checkGate(
  id: AgentId,
  status: AgentStatus,
  ctx: InstallContext,
): Promise<Check | undefined> {
  if (!status.installed) return undefined
  if (id === 'claude-desktop') return check('gate', 'skip', 'poll tier: no unattended peer turns', id)
  const gated =
    id === 'claude-code'
      ? hasPreToolUse(
          await readJson(ctx.sys, join(status.pluginPath ?? ctx.layout.claudePlugin, 'hooks', 'hooks.json')),
        )
      : await codexGate(ctx)
  return gated
    ? check('gate', 'ok', 'PreToolUse gate registered', id)
    : check('gate', 'fail', 'no PreToolUse gate in the installed plugin: peer turns are not gated', id)
}

async function codexGate(ctx: InstallContext): Promise<boolean> {
  const manifest = await readJson(ctx.sys, join(await codexPluginRoot(ctx), '.codex-plugin', 'plugin.json'))
  return isJsonObject(manifest) && hasPreToolUse(manifest.hooks)
}

/** config.json parses (it holds the peer-turn allowlist the gate enforces). */
export async function checkConfig(home: string, sys: Sys): Promise<Check> {
  const local = new LocalHome({ root: home, userHome: sys.home })
  try {
    const config = await local.readConfig()
    const tools = config.peer_turn.allow_tools.join(', ')
    return check('config', 'ok', `${local.paths.config}: peer turns may use ${tools}`)
  } catch (error) {
    return check('config', 'fail', `${local.paths.config}: ${error instanceof Error ? error.message : error}`)
  }
}

export async function checkSelftests(
  ctx: InstallContext,
  installed: readonly AgentId[],
): Promise<readonly Check[]> {
  const surfaces = [...new Set(installed.map((id) => AGENTS[id].surface))]
  const binary = (await ctx.sys.isExecutable(ctx.binary)) ? ctx.binary : ctx.currentBinary
  const results = await Promise.all(surfaces.map((surface) => selftest(ctx.sys, binary, surface)))
  return results.map((result) => check('mcp', result.ok ? 'ok' : 'fail', result.line))
}

/** A synthetic `permission` op (no side effects) to every live bridge's control socket. */
export async function checkBridges(home: string, timeoutMs: number): Promise<Check> {
  const bridges = await listBridges(join(home, 'run'))
  if (bridges.length === 0)
    return check('bridge', 'skip', 'no bridge running (start a session in your agent)')
  const results = await Promise.all(
    bridges.map(async (bridge) => {
      try {
        await callControl(
          bridge.socket,
          'permission',
          { local_key: 'agent-peers-doctor', tool: 'agent_peers_doctor_probe' },
          { timeoutMs },
        )
        return undefined
      } catch (error) {
        return `bridge ${bridge.pid} (${bridge.agent_kind}): ${error instanceof Error ? error.message : error}`
      }
    }),
  )
  const failures = results.filter((line): line is string => line !== undefined)
  if (failures.length > 0) return check('bridge', 'fail', failures.join('; '))
  return check('bridge', 'ok', `hook -> bridge round-trip ok (${bridges.length} bridge(s))`)
}

/** Hubs from config.json `default_hub` and credentials.json. */
export async function knownHubs(home: string, sys: Sys): Promise<readonly string[]> {
  const local = new LocalHome({ root: home, userHome: sys.home })
  const config = await local.readConfig().catch(() => undefined)
  const credentials = await local.readCredentials().catch(() => undefined)
  const all = [
    ...(config?.default_hub ? [hubOrigin(config.default_hub)] : []),
    ...Object.keys(credentials?.hubs ?? {}),
  ]
  return [...new Set(all)]
}

/** TLS rule (PROTOCOL §1): plain http only to loopback, LAN and tailnet hosts; then GET /install.sh. */
export async function checkHub(origin: string, fetchFn: typeof fetch, timeoutMs: number): Promise<Check> {
  const url = new URL(origin)
  if (url.protocol === 'http:' && !isPrivateHost(url.hostname))
    return check('hub', 'fail', `${origin}: plain http to a public host; use https (wss)`)
  try {
    const response = await fetchFn(`${origin}/install.sh`, {
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!response.ok) return check('hub', 'fail', `${origin}: HTTP ${response.status}`)
    return check('hub', 'ok', `${origin} reachable${url.protocol === 'https:' ? ' (TLS)' : ''}`)
  } catch (error) {
    return check('hub', 'fail', `${origin}: unreachable (${error instanceof Error ? error.message : error})`)
  }
}

export const isRecorded = (state: InstallState, id: AgentId): boolean => state[id] !== undefined

export async function agentStatus(detection: AgentDetection, ctx: InstallContext): Promise<AgentStatus> {
  return installerFor(detection.id).status(detection, ctx)
}
