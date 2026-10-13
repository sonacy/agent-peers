/** One hooked Claude Code session (control socket, joined to a room as @work) in a test world. */

import { expect } from 'bun:test'
import { mkdir, realpath } from 'node:fs/promises'
import { join } from 'node:path'
import { type ControlOp, type ControlParamsInput, callControl } from '@agent-peers/core'
import { claudeCodeInjector } from '../../src/injectors/claude-code/injector'
import type { BridgeHarness, Peer, World } from './world'

let pids = 5300

/** A clock the test can move forward (lease expiry, waiter grace). */
export function offsetClock() {
  let offset = 0
  return {
    clock: {
      now: () => Date.now() + offset,
      setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
      clearTimeout: (handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    },
    advance: (ms: number) => {
      offset += ms
    },
  }
}

export interface ClaudeSetup {
  readonly alice: Peer
  readonly cc: BridgeHarness
  readonly roomId: string
  readonly workspace: string
  readonly advance: (ms: number) => void
  ctl<Op extends ControlOp>(op: Op, params: ControlParamsInput<Op>): ReturnType<typeof callControl<Op>>
}

/** A fresh control-socket pid for a bridge built outside `setupClaude`. */
export function nextPid(): number {
  pids += 1
  return pids
}

export async function setupClaude(world: World, options: { injector?: boolean } = {}): Promise<ClaudeSetup> {
  const alice = await world.peer('alice')
  const room = await world.room(alice, 'team', 'home')
  const pid = nextPid()
  const workspace = join(world.dir, `ws-${pid}`)
  await mkdir(workspace, { recursive: true })
  const { clock, advance } = offsetClock()
  const cc = await world.bridge('claude-code', {
    token: world.member('carol'),
    env: { CLAUDE_CODE_SESSION_ID: 'cc-1', CLAUDECODE: '1' },
    cwd: workspace,
    clock,
    ...(options.injector ? { injector: claudeCodeInjector() } : {}),
    controlSocket: { runDir: join(world.dir, `run-${pid}`), pid, ancestorPids: [pid, 1] },
  })
  const joined = await cc.call('peers_join', { invite: room.code, handle: 'work', remember: 'none' })
  expect(joined.isError).toBe(false)
  const socket = cc.bridge.controlSocketPath as string
  return {
    alice,
    cc,
    roomId: room.roomId,
    workspace: await realpath(workspace),
    advance,
    ctl: (op, params) => callControl(socket, op, params, { timeoutMs: 5000 }),
  }
}

/** The session the control socket's `cc-1` key maps to. */
export const ccSession = (cc: BridgeHarness) => cc.bridge.runtime?.registry.get('cc-1')
