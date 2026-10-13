/**
 * An isolated Codex install for live tests. Everything lives under one fs.mkdtemp root:
 *
 *   <root>/home            HOME for every process (so nothing defaults to the real ~/.codex or
 *                          ~/.agent-peers), with .codex/auth.json SYMLINKED to the real login
 *   <root>/home/.codex     CODEX_HOME: config.toml, plugin cache, sessions, the app-server daemon
 *   <root>/ph              AGENT_PEERS_HOME: deliberately NOT the default $HOME/.agent-peers, so
 *                          bridge state landing here proves the plugin's env_vars forwarded it
 *   <root>/bin/codex       symlink to the real Codex CLI (PATH has only this dir + /usr/bin:/bin)
 *   <root>/bin/agent-peers-logged  AGENT_PEERS_BIN: execs the fresh build, appends stderr to bridge.log
 *   <root>/ws-*            git workspaces the threads run in
 *
 * The plugin is installed with the real CLI path (`agent-peers add -a codex -y`). Hooks are trusted
 * the way the Codex desktop app does it: `hooks/list` → `config/batchWrite hooks.state.<key>.trusted_hash`
 * on an app-server running in this CODEX_HOME. Cleanup stops the daemon and kills every process whose
 * command line names the root.
 */
import { existsSync } from 'node:fs'
import { chmod, mkdir, mkdtemp, readlink, realpath, rm, symlink } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { CodexRpc, type ServerRequestPolicy } from './codex-rpc'

export const REPO_ROOT = join(import.meta.dir, '..', '..', '..')
export const FRESH_BIN = join(REPO_ROOT, 'packages', 'cli', 'dist', 'agent-peers')
export const CODEX_CANDIDATES: readonly string[] = [
  '/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex',
]

export interface RunResult {
  readonly exitCode: number | null
  readonly stdout: string
  readonly stderr: string
}

export interface CodexLiveEnv {
  readonly root: string
  readonly home: string
  readonly codexHome: string
  readonly peersHome: string
  readonly codex: string
  readonly bridgeLog: string
  readonly env: Readonly<Record<string, string>>
  workspace(name: string): Promise<string>
  run(argv: readonly string[], options?: { cwd?: string; timeoutMs?: number }): Promise<RunResult>
  /** An app-server JSON-RPC client: embedded (`app-server`) or the shared daemon (`app-server proxy`). */
  appServer(mode: 'embedded' | 'daemon', cwd: string, policy: ServerRequestPolicy): Promise<CodexRpc>
  /** Records where the daemon socket points (outside the root) so cleanup can remove its lock. */
  rememberDaemonSocket(): Promise<void>
  cleanup(): Promise<void>
}

/** The Codex CLI to drive: $CODEX_LIVE_BIN, the ChatGPT.app bundle, then `codex` on PATH. */
export function findCodex(): string | undefined {
  const explicit = process.env.CODEX_LIVE_BIN?.trim()
  if (explicit) return explicit
  for (const path of CODEX_CANDIDATES) if (existsSync(path)) return path
  return Bun.which('codex') ?? undefined
}

const realAuth = (): string =>
  join(process.env.CODEX_LIVE_AUTH_HOME ?? join(homedir(), '.codex'), 'auth.json')

export function codexLivePrereqs(): string | undefined {
  if (!findCodex()) return 'no Codex CLI found'
  if (!existsSync(realAuth())) return `no Codex login at ${realAuth()}`
  if (!existsSync(FRESH_BIN)) return `no fresh build at ${FRESH_BIN}: run bun run build`
  return undefined
}

async function run(
  argv: readonly string[],
  env: Record<string, string>,
  cwd: string,
  timeoutMs: number,
): Promise<RunResult> {
  const proc = Bun.spawn([...argv], { env, cwd, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' })
  const timer = setTimeout(() => proc.kill('SIGKILL'), timeoutMs)
  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ])
    return { exitCode, stdout, stderr }
  } finally {
    clearTimeout(timer)
  }
}

/** Kills every process whose command line or environment (`ps -E`) names `root`: daemon, bridges, app-servers. */
export async function killUnder(root: string): Promise<readonly number[]> {
  const ps = Bun.spawnSync(['ps', '-axwwE', '-o', 'pid=,command='], { stdout: 'pipe' })
  const pids = ps.stdout
    .toString()
    .split('\n')
    .filter((line) => line.includes(root))
    .map((line) => Number.parseInt(line.trim(), 10))
    .filter((pid) => Number.isInteger(pid) && pid > 1 && pid !== process.pid)
  for (const pid of pids) {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      // already gone
    }
  }
  return pids
}

async function layout(root: string, codex: string) {
  const home = join(root, 'home')
  const codexHome = join(home, '.codex')
  const bin = join(root, 'bin')
  await mkdir(codexHome, { recursive: true })
  await mkdir(bin, { recursive: true })
  await symlink(realAuth(), join(codexHome, 'auth.json'))
  await symlink(codex, join(bin, 'codex'))
  const bridgeLog = join(root, 'bridge.log')
  const logged = join(bin, 'agent-peers-logged')
  await Bun.write(logged, `#!/bin/sh\nexec '${FRESH_BIN}' "$@" 2>>'${bridgeLog}'\n`)
  await chmod(logged, 0o755)
  return { home, codexHome, bin, bridgeLog, logged }
}

export async function createCodexEnv(): Promise<CodexLiveEnv> {
  const codex = findCodex()
  if (!codex) throw new Error('no Codex CLI')
  const root = await realpath(await mkdtemp(join(tmpdir(), 'peers-codex-live-')))
  const paths = await layout(root, codex)
  const env: Record<string, string> = {
    HOME: paths.home,
    CODEX_HOME: paths.codexHome,
    AGENT_PEERS_HOME: join(root, 'ph'),
    AGENT_PEERS_BIN: paths.logged,
    PATH: `${paths.bin}:/usr/bin:/bin:/usr/sbin:/sbin`,
    TMPDIR: tmpdir(),
    LANG: 'en_US.UTF-8',
  }
  const codexBin = join(paths.bin, 'codex')
  let daemonSockets: readonly string[] = []
  const rememberDaemonSocket = async () => {
    const target = await daemonSocketTarget(paths.home)
    if (target && !daemonSockets.includes(target)) daemonSockets = [...daemonSockets, target]
  }
  return {
    root,
    home: paths.home,
    codexHome: paths.codexHome,
    peersHome: env.AGENT_PEERS_HOME as string,
    codex: codexBin,
    bridgeLog: paths.bridgeLog,
    env,
    async workspace(name) {
      const dir = join(root, name)
      await mkdir(dir, { recursive: true })
      await run(['git', 'init', '-q', '.'], env, dir, 10_000)
      await Bun.write(
        join(dir, 'README.md'),
        `# ${name}\nA scratch workspace for the agent-peers live test.\n`,
      )
      return dir
    },
    run: (argv, options = {}) => run(argv, env, options.cwd ?? root, options.timeoutMs ?? 120_000),
    appServer: (mode, cwd, policy) =>
      CodexRpc.start({
        argv: mode === 'embedded' ? [codexBin, 'app-server'] : [codexBin, 'app-server', 'proxy'],
        env,
        cwd,
        policy,
        framing: mode === 'embedded' ? 'lines' : 'websocket',
      }),
    rememberDaemonSocket,
    async cleanup() {
      await rememberDaemonSocket()
      await run([codexBin, 'app-server', 'daemon', 'stop'], env, root, 20_000).catch(() => undefined)
      await killUnder(root)
      // The daemon's socket lives in a per-CODEX_HOME hashed path outside the root (/tmp/codex-daemon-<uid>/).
      for (const socket of daemonSockets)
        await Promise.all([rm(socket, { force: true }), rm(`${socket}.lock`, { force: true })])
      if (process.env.CODEX_LIVE_KEEP !== '1') await rm(root, { recursive: true, force: true })
    },
  }
}

/** Where `<CODEX_HOME>/app-server-control/app-server-control.sock` points (a hashed /tmp path). */
async function daemonSocketTarget(home: string): Promise<string | undefined> {
  try {
    return await readlink(join(home, '.codex', 'app-server-control', 'app-server-control.sock'))
  } catch {
    return undefined
  }
}

/** `agent-peers add -a codex -y` against the temp CODEX_HOME (the real installer path). */
export async function installPlugin(live: CodexLiveEnv): Promise<RunResult> {
  return live.run([FRESH_BIN, 'add', '-a', 'codex', '-y'], { timeoutMs: 180_000 })
}

export interface HookEntry {
  readonly key: string
  readonly eventName: string
  readonly currentHash: string
  readonly trustStatus: string
  readonly pluginId?: string | null
}

/** Trusts the peers plugin's hooks the way the desktop app's "Review hooks" does. */
export async function trustPeersHooks(rpc: CodexRpc, cwd: string): Promise<readonly HookEntry[]> {
  const listed = await rpc.request<{ data: { hooks: HookEntry[] }[] }>('hooks/list', { cwds: [cwd] })
  const hooks = (listed.data[0]?.hooks ?? []).filter((h) => h.pluginId === 'peers@agent-peers')
  const state = Object.fromEntries(hooks.map((h) => [h.key, { trusted_hash: h.currentHash }]))
  await rpc.request('config/batchWrite', {
    edits: [{ keyPath: 'hooks.state', mergeStrategy: 'upsert', value: state }],
    reloadUserConfig: true,
  })
  const after = await rpc.request<{ data: { hooks: HookEntry[] }[] }>('hooks/list', { cwds: [cwd] })
  return (after.data[0]?.hooks ?? []).filter((h) => h.pluginId === 'peers@agent-peers')
}

/** Starts the shared app-server daemon of this CODEX_HOME (what `codex queue` talks to). */
export async function startDaemon(live: CodexLiveEnv): Promise<Record<string, unknown>> {
  const result = await live.run([live.codex, 'app-server', 'daemon', 'start'], { timeoutMs: 60_000 })
  const line = result.stdout.trim().split('\n').at(-1) ?? ''
  if (result.exitCode !== 0) throw new Error(`daemon start failed: ${result.stderr}${result.stdout}`)
  await live.rememberDaemonSocket()
  return JSON.parse(line) as Record<string, unknown>
}

export async function stopDaemon(live: CodexLiveEnv): Promise<RunResult> {
  return live.run([live.codex, 'app-server', 'daemon', 'stop'], { timeoutMs: 30_000 })
}
