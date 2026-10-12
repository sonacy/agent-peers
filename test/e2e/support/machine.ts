/**
 * A simulated machine: its own HOME, AGENT_PEERS_HOME, CODEX_HOME and workspace under one temp dir,
 * plus a fake `codex` CLI that records `codex queue` calls. Every process a test starts for this
 * machine gets only this environment, so nothing reaches the real ~/.agent-peers, ~/.claude or
 * ~/.codex, and the real claude/codex binaries are never run.
 */
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type AutojoinEntry, LocalHome } from './deps'

export interface QueueCall {
  readonly thread: string
  readonly message: string
  readonly at: number
}

export interface Machine {
  readonly name: string
  readonly dir: string
  /** AGENT_PEERS_HOME. */
  readonly home: string
  /** Realpath of the workspace the agent runs in. */
  readonly workspace: string
  /** Path of the fake Codex CLI. */
  readonly codexPath: string
  /** Base environment for every process of this machine. */
  readonly env: Readonly<Record<string, string>>
  localHome(): LocalHome
  autojoin(): Promise<readonly AutojoinEntry[]>
  /** `codex queue` calls the fake CLI recorded, oldest first. */
  queueCalls(): Promise<readonly QueueCall[]>
  /** Makes the fake `codex queue` fail (exit 1) until called with false. */
  failQueue(fail: boolean): Promise<void>
  dispose(): Promise<void>
}

/** A Bun script standing in for the Codex CLI: `--version` and `queue --thread T --message M`. */
function fakeCodexScript(log: string, failFlag: string): string {
  return `#!${process.execPath}
import { appendFileSync, existsSync } from 'node:fs'
const args = process.argv.slice(2)
if (args[0] === '--version') {
  console.log('codex-cli 0.160.1')
  process.exit(0)
}
if (args[0] !== 'queue') {
  console.error('fake codex: unsupported command ' + args.join(' '))
  process.exit(64)
}
const value = (flag) => {
  const i = args.indexOf(flag)
  return i >= 0 ? args[i + 1] : undefined
}
if (existsSync(${JSON.stringify(failFlag)})) {
  console.error('fake codex: thread is not loaded')
  process.exit(1)
}
const entry = { thread: value('--thread'), message: value('--message'), at: Date.now() }
appendFileSync(${JSON.stringify(log)}, JSON.stringify(entry) + '\\n')
console.log('queued')
`
}

export async function createMachine(name: string): Promise<Machine> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), `ape2e-${name}-`)))
  const home = join(dir, 'agent-peers')
  const workspace = join(dir, 'work', name)
  const bin = join(dir, 'bin')
  const codexHome = join(dir, '.codex')
  await Promise.all([mkdir(workspace, { recursive: true }), mkdir(bin), mkdir(codexHome)])
  await writeFile(join(workspace, 'README.md'), `# ${name}\n`)
  const log = join(dir, 'codex-queue.jsonl')
  const failFlag = join(dir, 'codex-queue.fail')
  const codexPath = join(bin, 'codex')
  await writeFile(codexPath, fakeCodexScript(log, failFlag))
  await chmod(codexPath, 0o755)
  const env = {
    HOME: dir,
    AGENT_PEERS_HOME: home,
    CODEX_HOME: codexHome,
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    TMPDIR: tmpdir(),
  }
  return {
    name,
    dir,
    home,
    workspace,
    codexPath,
    env,
    localHome: () => new LocalHome({ root: home, userHome: dir }),
    autojoin: () => new LocalHome({ root: home, userHome: dir }).readAutojoin(),
    async queueCalls() {
      const text = await readFile(log, 'utf8').catch(() => '')
      return text
        .split('\n')
        .filter((line) => line.trim().length > 0)
        .map((line) => JSON.parse(line) as QueueCall)
    },
    async failQueue(fail) {
      if (fail) await writeFile(failFlag, '1')
      else await rm(failFlag, { force: true })
    },
    dispose: () => rm(dir, { recursive: true, force: true }),
  }
}
