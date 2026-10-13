/**
 * One live "machine" for a real Claude Code run: a temp root with its own AGENT_PEERS_HOME, a git
 * workspace Claude runs in, and an AGENT_PEERS_BIN wrapper around the freshly built binary.
 *
 * The wrapper `exec`s the real binary (so hook→bridge discovery by ancestor PID still works) and
 * only adds observability: every invocation is appended to `logs/trace.log`, and the bridge's stderr
 * (`mcp …`) goes to `logs/bridge.log`. Hook stderr is left alone: the asyncRewake waiter's stderr
 * IS the wake text Claude reads.
 *
 * Claude itself keeps the real HOME (the user's login); nothing here writes under ~/.claude except
 * the session transcripts Claude writes on its own.
 */
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

export const REPO_ROOT = resolve(import.meta.dir, '../../../..')
export const BUILT_BINARY = join(REPO_ROOT, 'packages/cli/dist/agent-peers')
export const PLUGIN_DIR = join(REPO_ROOT, 'adapters/claude-code')

export interface LiveMachine {
  readonly root: string
  /** AGENT_PEERS_HOME. */
  readonly home: string
  /** Realpath of the git workspace Claude runs in. */
  readonly workspace: string
  readonly logs: string
  /** The AGENT_PEERS_BIN wrapper. */
  readonly wrapper: string
  /** Extra environment for every Claude process of this machine. */
  readonly env: Readonly<Record<string, string>>
  readFile(relative: string): Promise<string>
  /** hooks.log, trace.log, bridge.log and autojoin.json, for failure reports. */
  diagnostics(): Promise<string>
  /** agent-peers processes this machine started (bridge, waiters) that are still alive. */
  livePids(): Promise<readonly number[]>
  /** Kills them (SIGTERM); returns how many there were. */
  killStrays(): Promise<number>
  dispose(): Promise<void>
}

function commandOf(pid: number): string {
  const ps = Bun.spawnSync(['ps', '-o', 'command=', '-p', String(pid)])
  return ps.exitCode === 0 ? ps.stdout.toString().trim() : ''
}

function wrapperScript(binary: string, logs: string): string {
  const q = (s: string) => `'${s.replaceAll("'", "'\\''")}'`
  return `#!/bin/sh
# live-test wrapper: trace, then exec the real agent-peers binary (keeps the PID chain intact)
printf '%s pid=%s ppid=%s %s\\n' "$(date +%H:%M:%S)" "$$" "$PPID" "$*" >> ${q(join(logs, 'trace.log'))}
if [ "\${1:-}" = "mcp" ]; then
  exec ${q(binary)} "$@" 2>> ${q(join(logs, 'bridge.log'))}
fi
if [ "\${1:-}" = "hook" ] && [ "\${2:-}" = "session-start" ]; then
  # keep SessionStart's stdin (what Claude Code really sends), then exec with it
  input=${q(join(logs, 'session-start'))}.$$
  cat > "$input"
  { cat "$input"; echo; } >> ${q(join(logs, 'session-start.jsonl'))}
  exec ${q(binary)} "$@" < "$input"
fi
exec ${q(binary)} "$@"
`
}

async function gitInit(dir: string): Promise<void> {
  const run = Bun.spawn(['git', 'init', '-q', '-b', 'main', dir], { stdout: 'ignore', stderr: 'pipe' })
  if ((await run.exited) !== 0) throw new Error(`git init failed: ${await new Response(run.stderr).text()}`)
}

/**
 * Unix socket paths are capped at 104 bytes on macOS, and the bridge binds `<home>/run/<pid>.sock`:
 * under the per-user $TMPDIR (/var/folders/…) that is too long, so live machines live under /tmp.
 */
const SHORT_TMP = process.env.AGENT_PEERS_LIVE_TMP ?? (process.platform === 'win32' ? tmpdir() : '/tmp')
/** AGENT_PEERS_HOME, relative to the machine root. */
export const HOME_REL = 'h'

export async function createLiveMachine(name: string): Promise<LiveMachine> {
  const root = await realpath(await mkdtemp(join(SHORT_TMP, 'apl-')))
  const home = join(root, HOME_REL)
  const workspace = join(root, name)
  const logs = join(root, 'logs')
  const wrapper = join(root, 'bin', 'agent-peers')
  await Promise.all([
    mkdir(workspace, { recursive: true }),
    mkdir(logs, { recursive: true }),
    mkdir(join(root, 'bin')),
    mkdir(home, { recursive: true, mode: 0o700 }),
  ])
  await gitInit(workspace)
  await writeFile(join(workspace, 'NOTES.md'), `# ${name}\n\nThe project code name is "pelican".\n`)
  await writeFile(wrapper, wrapperScript(BUILT_BINARY, logs))
  await chmod(wrapper, 0o755)
  const readRel = (relative: string) => readFile(join(root, relative), 'utf8').catch(() => '')
  const livePids = async (): Promise<readonly number[]> => {
    const trace = await readRel('logs/trace.log')
    const pids = new Set([...trace.matchAll(/ pid=(\d+) /g)].map((m) => Number(m[1])))
    return [...pids].filter((pid) => commandOf(pid).includes(BUILT_BINARY))
  }
  return {
    root,
    home,
    workspace,
    logs,
    wrapper,
    env: { AGENT_PEERS_HOME: home, AGENT_PEERS_BIN: wrapper },
    readFile: readRel,
    async diagnostics() {
      const parts = await Promise.all(
        [
          `${HOME_REL}/logs/hooks.log`,
          'logs/trace.log',
          'logs/bridge.log',
          'logs/session-start.jsonl',
          `${HOME_REL}/autojoin.json`,
        ].map(async (rel) => `--- ${rel}\n${(await readRel(rel)).slice(-6000)}`),
      )
      return parts.join('\n')
    },
    livePids,
    async killStrays() {
      const pids = await livePids()
      for (const pid of pids) {
        try {
          process.kill(pid, 'SIGTERM')
        } catch {
          // already gone
        }
      }
      return pids.length
    },
    dispose: () => rm(root, { recursive: true, force: true }),
  }
}
