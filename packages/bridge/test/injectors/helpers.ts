/**
 * Shared setup for injector tests: a Claude Code bridge with a control socket in a temp home, and a
 * hook runner that discovers it through a fake process tree (hook pid → fake agent pid).
 */
import { mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ProcessTree } from '@agent-peers/core'
import type { ClaudeHookInput } from '../../src/injectors/claude-code/input'
import { fileLogger, hookLogPath } from '../../src/injectors/claude-code/log'
import type { HookResult } from '../../src/injectors/claude-code/output'
import { type ClaudeHookDeps, runClaudeHook } from '../../src/injectors/claude-code/run'
import { HookState } from '../../src/injectors/claude-code/state'
import { discoveryCaller } from '../../src/injectors/claude-code/transport'
import type { WaiterOptions } from '../../src/injectors/claude-code/waiter'
import type { BridgeHarness, Peer, World } from '../helpers/world'

export const FIXTURES = join(import.meta.dir, '../../../../test/fixtures/hooks/claude-code')

export async function fixture(name: string, patch: Partial<ClaudeHookInput> = {}): Promise<string> {
  const base = JSON.parse(await readFile(join(FIXTURES, `${name}.json`), 'utf8')) as Record<string, unknown>
  return JSON.stringify({ ...base, ...patch })
}

/** hook pid → agent pid → 1. The bridge advertises the agent pid as its ancestor. */
export function fakeTree(hookPid: number, agentPid: number): ProcessTree {
  const parents = new Map<number, number>([
    [hookPid, agentPid],
    [agentPid, 1],
  ])
  return {
    lookup: async (pid) => {
      const ppid = parents.get(pid)
      return ppid === undefined ? undefined : { ppid, comm: 'fake' }
    },
    isAlive: () => true,
  }
}

let nextPid = 910_000

export interface ClaudeSetup {
  readonly alice: Peer
  readonly cc: BridgeHarness
  readonly roomId: string
  readonly workspace: string
  readonly runDir: string
  readonly logPath: string
  readonly deps: ClaudeHookDeps
  hook(
    event: string,
    stdin: string,
    options?: { wait?: boolean; waiter?: Partial<WaiterOptions> },
  ): Promise<HookResult>
}

/** A Claude Code bridge (env session cc-1) that joined alice's room as @work. */
export async function claudeSetup(world: World): Promise<ClaudeSetup> {
  const alice = await world.peer('alice')
  const room = await world.room(alice, 'team', 'home')
  const workspace = join(world.dir, 'ws')
  await mkdir(workspace, { recursive: true })
  nextPid += 3
  const [bridgePid, agentPid, hookPid] = [nextPid, nextPid + 1, nextPid + 2]
  const homeDir = join(world.dir, `cc-home-${bridgePid}`)
  const runDir = join(homeDir, 'run')
  const cc = await world.bridge('claude-code', {
    token: world.member('carol'),
    homeDir,
    env: { CLAUDE_CODE_SESSION_ID: 'cc-1', CLAUDECODE: '1' },
    cwd: workspace,
    controlSocket: { runDir, pid: bridgePid, ancestorPids: [bridgePid, agentPid] },
  })
  const joined = await cc.call('peers_join', { invite: room.code, handle: 'work', remember: 'none' })
  if (joined.isError) throw new Error(joined.text)
  const logPath = hookLogPath(homeDir)
  const deps: ClaudeHookDeps = {
    caller: discoveryCaller({ runDir, pid: hookPid, tree: fakeTree(hookPid, agentPid) }),
    state: new HookState(runDir),
    log: fileLogger(logPath, () => undefined),
  }
  return {
    alice,
    cc,
    roomId: room.roomId,
    workspace,
    runDir,
    logPath,
    deps,
    hook: (event, stdin, options = {}) =>
      runClaudeHook(
        {
          event,
          stdin,
          env: {},
          ...(options.wait === undefined ? {} : { wait: options.wait }),
          waiter: { budgetMs: 3000, retryMs: 20, reconnectWindowMs: 500, ...options.waiter },
        },
        deps,
      ),
  }
}

export const parseOut = (result: HookResult): Record<string, unknown> =>
  JSON.parse(result.stdout) as Record<string, unknown>

export const readLog = (path: string): Promise<string> => readFile(path, 'utf8').catch(() => '')
