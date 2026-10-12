/**
 * Process-tree access for control-socket discovery (ARCHITECTURE §5). Injectable so tests can use
 * fake ancestor chains; the default shells out to `ps -o ppid=,comm= -p <pid>`.
 */

export interface ProcessEntry {
  readonly ppid: number
  /** Executable name (`comm`), when known. */
  readonly comm?: string
  /** Full command line, fetched only for runtimes (`node`, `bun`) to tell `npx` from an agent. */
  readonly args?: string
}

export interface ProcessTree {
  /** Parent and name of `pid`, or undefined when it does not exist. */
  lookup(pid: number): Promise<ProcessEntry | undefined>
  /** True when `pid` exists (signal 0). */
  isAlive(pid: number): boolean
}

/** Upper bound on the walk, in case `ps` reports a cycle. */
export const MAX_ANCESTOR_DEPTH = 64

/** Signal 0 probes existence; EPERM still means the process exists. */
export function pidIsAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'EPERM'
  }
}

/** Parses one `ps -o ppid=,comm=` line. */
export function parsePsLine(output: string): ProcessEntry | undefined {
  const match = /^\s*(\d+)\s*(.*?)\s*$/s.exec(output.split('\n')[0] ?? '')
  if (!match) return undefined
  const ppid = Number(match[1])
  const comm = match[2]
  return comm ? { ppid, comm } : { ppid }
}

async function ps(pid: number, format: string): Promise<string | undefined> {
  const proc = Bun.spawn(['ps', '-o', format, '-p', String(pid)], {
    stdout: 'pipe',
    stderr: 'ignore',
    stdin: 'ignore',
  })
  const [text, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited])
  return code === 0 ? text : undefined
}

export const psProcessTree: ProcessTree = Object.freeze({
  async lookup(pid: number): Promise<ProcessEntry | undefined> {
    if (!Number.isInteger(pid) || pid <= 0) return undefined
    const text = await ps(pid, 'ppid=,comm=')
    const entry = text === undefined ? undefined : parsePsLine(text)
    if (!entry || !RUNTIME_NAMES.has(processName(entry.comm))) return entry
    const args = (await ps(pid, 'args='))?.trim()
    return args ? { ...entry, args } : entry
  },
  isAlive: pidIsAlive,
})

/** PID 1 and launchd are shared by everything, so they never identify an agent. */
export function isSharedAncestor(pid: number, comm?: string): boolean {
  if (pid <= 1) return true
  const name = comm?.split('/').pop()
  return name === 'launchd'
}

/**
 * `pid` followed by its ancestors, nearest first, stopping before PID 1 / launchd. With
 * `includeSelf: false` the list starts at the parent.
 */
export async function ancestorChain(
  tree: ProcessTree,
  pid: number,
  options: { readonly includeSelf?: boolean } = {},
): Promise<readonly number[]> {
  const chain: number[] = []
  const seen = new Set<number>()
  let current = pid
  let entry = await tree.lookup(current)
  if (options.includeSelf !== false && !isSharedAncestor(current, entry?.comm)) chain.push(current)
  while (entry && chain.length < MAX_ANCESTOR_DEPTH) {
    seen.add(current)
    current = entry.ppid
    if (seen.has(current)) break
    entry = await tree.lookup(current)
    if (isSharedAncestor(current, entry?.comm)) break
    chain.push(current)
  }
  return chain
}

/**
 * Launchers between an agent and the processes it starts (`sh -c`, `npx`, the agent-peers shim).
 * They are skipped when looking for the agent process itself.
 */
const SHIM_NAMES: ReadonlySet<string> = new Set([
  'sh',
  'bash',
  'zsh',
  'dash',
  'ksh',
  'fish',
  'env',
  'bunx',
  'npx',
  'npm',
  'pnpm',
  'pnpx',
  'yarn',
  'agent-peers',
  'current',
])

/** Runtimes that are a launcher when they run a package runner, and an agent otherwise (node Claude). */
const RUNTIME_NAMES: ReadonlySet<string> = new Set(['node', 'nodejs', 'bun'])
const RUNNER_ARGS =
  /(^|[\s/])(npx|npm|npm-cli\.js|npx-cli\.js|pnpm|pnpx|yarn|bunx|agent-peers)(\s|$|\.js|@)|\b_npx\b|\bnpm exec\b/

/** `comm` without its directory and the login-shell dash (`-zsh`). */
export const processName = (comm: string | undefined): string =>
  (comm?.split('/').pop() ?? '').replace(/^-/, '').toLowerCase()

/** A launcher, not an agent. A runtime without a known command line counts as a launcher. */
export function isShim(comm: string | undefined, args?: string): boolean {
  const name = processName(comm)
  if (SHIM_NAMES.has(name)) return true
  if (!RUNTIME_NAMES.has(name)) return false
  return args === undefined || RUNNER_ARGS.test(args)
}

/**
 * The agent process that started `pid`: its nearest ancestor that is not a launcher. Undefined when
 * the walk reaches PID 1 / launchd first. `node` / `bun` count as launchers only when their command
 * line runs a package runner (npx, npm exec, bunx) or agent-peers; a node-based agent is the agent.
 */
export async function agentAncestor(tree: ProcessTree, pid: number): Promise<number | undefined> {
  const seen = new Set<number>([pid])
  let entry = await tree.lookup(pid)
  for (let depth = 0; entry && depth < MAX_ANCESTOR_DEPTH; depth++) {
    const current = entry.ppid
    if (seen.has(current)) return undefined
    seen.add(current)
    entry = await tree.lookup(current)
    if (isSharedAncestor(current, entry?.comm)) return undefined
    if (!isShim(entry?.comm, entry?.args)) return current
  }
  return undefined
}
