import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  type ControlHandler,
  type ControlOp,
  type ControlParamsInput,
  type ControlResult,
  ControlServer,
  type ProcessTree,
} from '@agent-peers/core'
import { type ErrorCode, PeersError } from '@agent-peers/protocol'
import { gateInput, MAX_GATE_INPUT_CHARS } from '../../src/injectors/claude-code/events'
import { runClaudeHook } from '../../src/injectors/claude-code/run'
import { HookState } from '../../src/injectors/claude-code/state'
import { type BridgeCaller, discoveryCaller } from '../../src/injectors/claude-code/transport'

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'apb-safe-'))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

type Answer = (params: Record<string, unknown>) => unknown

function caller(script: Partial<Record<ControlOp, Answer[]>>): BridgeCaller & { ops: string[] } {
  const ops: string[] = []
  return {
    ops,
    locate: async () => 4242,
    async call<Op extends ControlOp>(op: Op, params: ControlParamsInput<Op>) {
      ops.push(op)
      const answers = script[op] ?? [() => ({})]
      const answer = (answers.length > 1 ? answers.shift() : answers[0]) as Answer
      return { bridgePid: 4242, result: answer(params as Record<string, unknown>) as ControlResult<Op> }
    },
  }
}

async function run(event: string, c: BridgeCaller, fields: Record<string, unknown> = {}) {
  const lines: string[] = []
  const state = new HookState(join(dir, 'run'))
  const out = await runClaudeHook(
    { event, stdin: JSON.stringify({ session_id: 'k1', hook_event_name: event, ...fields }), env: {} },
    {
      caller: c,
      state,
      log: async (line) => {
        lines.push(line)
      },
    },
  )
  return { out, lines, state }
}

const fail = (code: ErrorCode) => () => {
  throw new PeersError(code, code)
}

describe('UserPromptSubmit take', () => {
  it('prints the envelopes already taken when a later take fails', async () => {
    const c = caller({
      take: [() => ({ envelope: 'FIRST', inject_id: 'i1' }), fail('timeout')],
    })
    const { out, lines, state } = await run('UserPromptSubmit', c)
    expect(out.stdout).toContain('FIRST')
    expect(lines.join('\n')).toContain('take failed after earlier envelopes')
    expect(await state.readInjectIds('k1')).toEqual(['i1'])
    expect(c.ops).toEqual(['activity', 'take', 'take'])
  })

  it('still takes when reporting activity fails', async () => {
    const c = caller({
      activity: [fail('internal')],
      take: [() => ({ envelope: 'ONLY', inject_id: 'i2' }), () => null],
    })
    const { out } = await run('UserPromptSubmit', c)
    expect(out.stdout).toContain('ONLY')
  })
})

describe('PreToolUse fails closed', () => {
  const tool = { tool_name: 'Write', tool_input: { file_path: '/w/a', content: 'x' } }

  it('allows the tool when no bridge exists and nothing was handed to the session', async () => {
    const { out } = await run('PreToolUse', caller({ gate: [fail('not_connected')] }), tool)
    expect(out.stdout).toBe('{}\n')
  })

  it('denies when envelopes were handed to the session since its last Stop', async () => {
    const state = new HookState(join(dir, 'run'))
    await state.rememberInjectId('k1', 'inj_9')
    const { out } = await run('PreToolUse', caller({ gate: [fail('not_connected')] }), tool)
    expect(JSON.parse(out.stdout).hookSpecificOutput.permissionDecision).toBe('deny')
  })

  it('denies when the bridge was reached but could not answer', async () => {
    for (const code of ['timeout', 'internal', 'invalid_result'] as const) {
      const { out } = await run('PreToolUse', caller({ gate: [fail(code)] }), tool)
      expect(JSON.parse(out.stdout).hookSpecificOutput.permissionDecisionReason).toContain(code)
    }
  })

  it('sends oversized inputs without their bulky fields', () => {
    const big = { file_path: '/w/a', content: 'x'.repeat(MAX_GATE_INPUT_CHARS + 10), nested: { a: 1 } }
    expect(gateInput(big)).toEqual({ file_path: '/w/a', nested: { a: 1 } })
    const small = { command: 'ls' }
    expect(gateInput(small)).toBe(small)
    expect(gateInput('text')).toBe('text')
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    expect(gateInput(cyclic)).toEqual({})
  })
})

describe('discoveryCaller', () => {
  const tree = (alive: () => readonly number[]): ProcessTree => ({
    lookup: async (pid) =>
      ({ 900: { ppid: 50, comm: 'sh' }, 50: { ppid: 1, comm: 'claude' } })[pid] as
        | { ppid: number; comm: string }
        | undefined,
    isAlive: (pid) => alive().includes(pid),
  })

  it('discovers once per hook process and rediscovers a restarted bridge', async () => {
    const runDir = join(dir, 'run')
    const handler = (tag: string): ControlHandler => ({
      register: async () => ({ context: tag }),
      activity: async () => ({}),
      take: async () => null,
      wait: async () => null,
      turn_end: async () => ({}),
      end: async () => ({}),
      gate: async () => ({ decision: 'allow', reason: tag }),
      permission: async () => ({}),
      autojoin: async () => ({ accepted: true }),
    })
    let live: number[] = [101]
    const first = await ControlServer.start({
      runDir,
      handler: handler('one'),
      agentKind: 'claude-code',
      pid: 101,
      agentPid: 50,
      ancestorPids: [101, 50],
    })
    const c = discoveryCaller({ runDir, pid: 900, tree: tree(() => live) })
    expect(await c.locate('k')).toBe(101)
    expect((await c.call('gate', { local_key: 'k', tool: 'Read', input: {} })).result.reason).toBe('one')
    await first.close()
    live = [102]
    const second = await ControlServer.start({
      runDir,
      handler: handler('two'),
      agentKind: 'claude-code',
      pid: 102,
      agentPid: 50,
      ancestorPids: [102, 50],
    })
    try {
      const again = await c.call('gate', { local_key: 'k', tool: 'Read', input: {} })
      expect(again.bridgePid).toBe(102)
      expect(again.result.reason).toBe('two')
    } finally {
      await second.close()
    }
  })
})
