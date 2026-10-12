import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ControlOp, ControlParamsInput, ControlResult } from '@agent-peers/core'
import { MAX_WAIT_MS } from '@agent-peers/core'
import { PeersError } from '@agent-peers/protocol'
import type { HookClock, HookContext } from '../../src/injectors/claude-code/events'
import { normalizeEvent, parseHookInput } from '../../src/injectors/claude-code/input'
import { fileLogger } from '../../src/injectors/claude-code/log'
import { additionalContext, wakeResult } from '../../src/injectors/claude-code/output'
import {
  DEFAULT_WAIT_TIMEOUT_S,
  defaultClaudeHookDeps,
  runClaudeHook,
} from '../../src/injectors/claude-code/run'
import { HookState } from '../../src/injectors/claude-code/state'
import type { BridgeCaller } from '../../src/injectors/claude-code/transport'
import { runWaiter } from '../../src/injectors/claude-code/waiter'

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'apb-inj-'))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

/** A clock that advances only when the code under test waits. */
function fakeClock(): HookClock & { advance(ms: number): void } {
  let now = 1_000_000
  return {
    now: () => now,
    sleep: async (ms) => {
      now += ms
    },
    advance: (ms) => {
      now += ms
    },
  }
}

type Answer = (params: Record<string, unknown>) => unknown

/** Scripted bridge: each op answers from a queue of functions (the last one repeats). */
function scriptedCaller(
  clock: ReturnType<typeof fakeClock>,
  script: Partial<Record<ControlOp, Answer[]>>,
  bridgePid = 4242,
) {
  const calls: { op: ControlOp; params: Record<string, unknown> }[] = []
  const caller: BridgeCaller = {
    locate: async () => bridgePid,
    async call<Op extends ControlOp>(op: Op, params: ControlParamsInput<Op>) {
      const p = params as Record<string, unknown>
      calls.push({ op, params: p })
      const answers = script[op] ?? [() => ({})]
      const answer = (answers.length > 1 ? answers.shift() : answers[0]) as Answer
      const value = answer(p)
      if (op === 'wait' && value === null) clock.advance(Number(p.timeout_ms))
      return { bridgePid, result: value as ControlResult<Op> }
    },
  }
  return { caller, calls }
}

const input = (fields: Record<string, unknown> = {}) =>
  parseHookInput(JSON.stringify({ session_id: 'k1', hook_event_name: 'Stop', ...fields }))

function context(caller: BridgeCaller, clock: HookClock, lines: string[] = []): HookContext {
  return {
    caller,
    clock,
    state: new HookState(join(dir, 'run')),
    log: async (line) => {
      lines.push(line)
    },
  }
}

describe('waiter', () => {
  it('re-arms in slices of at most MAX_WAIT_MS until an envelope arrives', async () => {
    const clock = fakeClock()
    const { caller, calls } = scriptedCaller(clock, {
      wait: [() => null, () => null, () => ({ envelope: '[agent-peers] ASK', inject_id: 'inj_1' })],
    })
    const out = await runWaiter(context(caller, clock), input(), { budgetMs: 3 * MAX_WAIT_MS })
    expect(out).toEqual(wakeResult('[agent-peers] ASK'))
    const waits = calls.filter((c) => c.op === 'wait')
    expect(waits.map((c) => c.params.timeout_ms)).toEqual([MAX_WAIT_MS, MAX_WAIT_MS, MAX_WAIT_MS])
    expect(calls.at(-1)).toEqual({ op: 'activity', params: { local_key: 'k1', state: 'busy' } })
    expect(await new HookState(join(dir, 'run')).takeInjectIds('k1')).toEqual(['inj_1'])
  })

  it('stops once its bridge runs another conversation', async () => {
    const clock = fakeClock()
    const { caller, calls } = scriptedCaller(clock, { wait: [() => null] })
    const ctx = context(caller, clock)
    await ctx.state.noteSessionStart(4242, 'k2', 'clear')
    const out = await runWaiter(ctx, input(), { budgetMs: 3 * MAX_WAIT_MS })
    expect(out.exitCode).toBe(0)
    expect(calls.filter((c) => c.op === 'wait')).toHaveLength(1)
  })

  it('keeps retrying while the bridge restarts, then resumes waiting', async () => {
    const clock = fakeClock()
    const unreachable = () => {
      throw new PeersError('not_connected', 'no bridge')
    }
    const { caller } = scriptedCaller(clock, {
      wait: [unreachable, unreachable, () => ({ envelope: 'E', inject_id: 'inj_2' })],
      activity: [unreachable],
    })
    const lines: string[] = []
    const out = await runWaiter(context(caller, clock, lines), input(), { budgetMs: 60_000, retryMs: 100 })
    expect(out.exitCode).toBe(2)
    // The confirmation failed (bridge gone again): logged, the wake still happens.
    expect(lines.join('\n')).toContain('confirming inj_2 failed')
  })

  it('retries bridge-side errors (a hub hiccup) instead of exiting, then wakes', async () => {
    const clock = fakeClock()
    const hiccup = () => {
      throw new PeersError('rate_limited', 'slow down')
    }
    const { caller, calls } = scriptedCaller(clock, {
      wait: [hiccup, hiccup, () => ({ envelope: 'E', inject_id: 'inj_3' })],
    })
    const out = await runWaiter(context(caller, clock), input(), { budgetMs: 60_000, retryMs: 100 })
    expect(out.exitCode).toBe(2)
    expect(calls.filter((c) => c.op === 'wait')).toHaveLength(3)
  })

  it('gives up on a failing bridge after the reconnect window, logs it and prints {}', async () => {
    const clock = fakeClock()
    const { caller } = scriptedCaller(clock, {
      wait: [
        () => {
          throw new PeersError('invalid_params', 'bad key')
        },
      ],
    })
    const lines: string[] = []
    const ctx = context(caller, clock, lines)
    const out = await runClaudeHook(
      {
        event: 'wait',
        stdin: JSON.stringify({ session_id: 'k1' }),
        env: {},
        waiter: { reconnectWindowMs: 1_000, retryMs: 100 },
      },
      { caller: ctx.caller, state: ctx.state, log: ctx.log, clock },
    )
    expect(out).toEqual({ exitCode: 0, stdout: '{}\n', stderr: '' })
    expect(lines.join('\n')).toContain('giving up: bad key')
  })

  it('exits at once with no budget left; a SessionStart registration error is logged, not fatal', async () => {
    const clock = fakeClock()
    const { caller } = scriptedCaller(clock, {
      register: [
        () => {
          throw new PeersError('internal', 'boom')
        },
      ],
      wait: [() => ({ envelope: 'E', inject_id: 'inj_4' })],
    })
    const lines: string[] = []
    const ctx = context(caller, clock, lines)
    expect((await runWaiter(ctx, input({ hook_event_name: 'Stop' }), { budgetMs: 0 })).exitCode).toBe(0)
    const out = await runWaiter(ctx, input({ hook_event_name: 'SessionStart' }), { budgetMs: 10 })
    expect(out.exitCode).toBe(2)
    expect(lines.join('\n')).toContain('register failed: boom')
  })
})

describe('hook state', () => {
  it('computes the same supersedes for both SessionStart hooks, in either order', async () => {
    const state = new HookState(join(dir, 'run'))
    expect(await state.noteSessionStart(7, 'a', 'startup')).toBeUndefined()
    expect(await state.noteSessionStart(7, 'b', 'clear')).toBe('a')
    expect(await state.noteSessionStart(7, 'b', 'clear')).toBe('a')
    expect(await state.currentKey(7)).toBe('b')
    expect(await state.noteSessionStart(7, 'c', 'compact')).toBeUndefined()
    expect(await state.currentKey(8)).toBeUndefined()
    const mode = (await stat(join(dir, 'run', 'hooks'))).mode & 0o777
    expect(mode).toBe(0o700)
  })

  it('remembers inject ids per key, deduplicated, and forgets them when taken', async () => {
    const state = new HookState(join(dir, 'run'))
    await state.rememberInjectId('k', 'i1')
    await state.rememberInjectId('k', 'i1')
    await state.rememberInjectId('k', 'i2')
    await state.rememberInjectId('other', 'i3')
    expect(await state.takeInjectIds('k')).toEqual(['i1', 'i2'])
    expect(await state.takeInjectIds('k')).toEqual([])
    expect(await state.takeInjectIds('other')).toEqual(['i3'])
  })

  it('treats a corrupt state file as absent', async () => {
    await mkdir(join(dir, 'run', 'hooks'), { recursive: true })
    await writeFile(join(dir, 'run', 'hooks', 'bridge-9.json'), '{nope')
    const state = new HookState(join(dir, 'run'))
    expect(await state.noteSessionStart(9, 'x', 'resume')).toBeUndefined()
    expect(await state.currentKey(9)).toBe('x')
  })
})

describe('input, output and logging', () => {
  it('normalizes event spellings', () => {
    expect(normalizeEvent('session-start')).toBe('SessionStart')
    expect(normalizeEvent('USER_PROMPT_SUBMIT')).toBe('UserPromptSubmit')
    expect(normalizeEvent('PreToolUse')).toBe('PreToolUse')
    expect(normalizeEvent('wait')).toBe('wait')
    expect(normalizeEvent('nope')).toBeUndefined()
    expect(normalizeEvent(undefined)).toBeUndefined()
  })

  it('builds additionalContext only for non-empty context', () => {
    expect(additionalContext('SessionStart', undefined)).toEqual({})
    expect(additionalContext('SessionStart', '')).toEqual({})
    expect(wakeResult('x\n').stderr).toBe('x\n')
  })

  it('writes the hook log with mode 0600 and falls back when it cannot', async () => {
    const path = join(dir, 'logs', 'hooks.log')
    await fileLogger(
      path,
      () => undefined,
      () => 0,
    )('first\nline')
    expect(await readFile(path, 'utf8')).toBe('1970-01-01T00:00:00.000Z first line\n')
    expect((await stat(path)).mode & 0o777).toBe(0o600)
    const blocked = join(dir, 'blocked')
    await writeFile(blocked, 'a file, not a dir')
    await chmod(blocked, 0o400)
    const fallback: string[] = []
    await fileLogger(join(blocked, 'hooks.log'), (line) => fallback.push(line))('lost')
    expect(fallback[0]).toContain('[agent-peers] lost (hook log unavailable')
  })

  it('wires default deps to the agent-peers home from the environment', async () => {
    const deps = defaultClaudeHookDeps({ AGENT_PEERS_HOME: dir }, { stderr: () => undefined })
    expect(await deps.caller.locate('k')).toBeUndefined()
    await expect(deps.caller.call('activity', { local_key: 'k', state: 'idle' })).rejects.toThrow(
      'no agent-peers bridge found',
    )
    await deps.log('hello')
    expect(await readFile(join(dir, 'logs', 'hooks.log'), 'utf8')).toContain('hello')
    expect(DEFAULT_WAIT_TIMEOUT_S).toBe(86_400)
  })

  it('maps SessionStart without a bridge to {} and a log line', async () => {
    const lines: string[] = []
    const out = await runClaudeHook(
      { event: 'session-start', stdin: JSON.stringify({ session_id: 'k', source: 'startup' }), env: {} },
      {
        caller: { locate: async () => undefined, call: async () => Promise.reject(new Error('unused')) },
        state: new HookState(join(dir, 'run')),
        log: async (line) => {
          lines.push(line)
        },
      },
    )
    expect(out.stdout).toBe('{}\n')
    expect(lines[0]).toContain('not_connected')
  })
})
