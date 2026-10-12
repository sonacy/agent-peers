import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runHookCommand } from '../src/commands/hook'
import { processIo, readStream } from '../src/io'
import { main } from '../src/program'
import { type CliWorld, memoryIo, startCliWorld } from './helpers/world'

const BIN = join(import.meta.dir, '../src/bin.ts')
const FIXTURES = join(import.meta.dir, '../../../test/fixtures/hooks/claude-code')

async function fixture(name: string, patch: Record<string, unknown> = {}): Promise<string> {
  const base = JSON.parse(await readFile(join(FIXTURES, `${name}.json`), 'utf8')) as Record<string, unknown>
  return JSON.stringify({ ...base, ...patch })
}

/** Runs the real `agent-peers` entrypoint as a hook process: stdin in, stdout/stderr/exit out. */
async function runBin(args: readonly string[], stdin: string, env: Record<string, string>) {
  const proc = Bun.spawn([process.execPath, BIN, ...args], {
    env: { PATH: process.env.PATH ?? '', ...env },
    stdin: new TextEncoder().encode(stdin),
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return { stdout, stderr, exitCode }
}

const logOf = (home: string) => readFile(join(home, 'logs', 'hooks.log'), 'utf8').catch(() => '')

describe('agent-peers hook (claude-code) against a running bridge', () => {
  let world: CliWorld
  beforeEach(async () => {
    world = await startCliWorld()
  })
  afterEach(async () => {
    await world.stop()
  })

  it('SessionStart from a hook process registers and prints additionalContext', async () => {
    const out = await runBin(
      ['hook', 'session-start', '--agent', 'claude-code'],
      await fixture('SessionStart', { session_id: 'cc-1' }),
      world.env,
    )
    expect(out.exitCode).toBe(0)
    const json = JSON.parse(out.stdout) as { hookSpecificOutput: { additionalContext: string } }
    expect(json.hookSpecificOutput.additionalContext).toContain('@work in room "team"')
  })

  it('the waiter process exits 2 with the envelope on stderr when a peer asks', async () => {
    const waiting = runBin(
      ['hook', 'wait', '--agent', 'claude-code', '--timeout', '30'],
      await fixture('Stop', { session_id: 'cc-1' }),
      world.env,
    )
    await Bun.sleep(400)
    const asked = await world.alice.ask({ room_id: world.roomId, to: 'work', text: 'wake up?' })
    const out = await waiting
    expect(out.exitCode).toBe(2)
    expect(out.stdout).toBe('')
    expect(out.stderr).toContain(`ask_id ${asked.id}`)
  })

  it('runs in-process with the default discovery: prompt submit injects, stop nudges', async () => {
    const asked = await world.alice.ask({ room_id: world.roomId, to: 'work', text: 'which port?' })
    await Bun.sleep(100)
    const prompt = memoryIo(world.env, await fixture('UserPromptSubmit', { session_id: 'cc-1' }))
    expect(await runHookCommand('user-prompt-submit', { agent: 'claude-code' }, prompt)).toBe(0)
    expect(prompt.out.join('')).toContain(`ask_id ${asked.id}`)
    const stop = memoryIo(world.env, await fixture('Stop', { session_id: 'cc-1' }))
    expect(await main(['hook', 'stop', '--agent', 'claude-code'], stop)).toBe(0)
    expect(JSON.parse(stop.out.join('')).decision).toBe('block')
  })
})

describe('agent-peers hook without a bridge', () => {
  let dir: string
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'apc-nb-'))
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('a hook process prints {} with exit 0 and logs a warning', async () => {
    const home = join(dir, 'home')
    const out = await runBin(
      ['hook', 'pre-tool-use', '--agent', 'claude-code'],
      await fixture('PreToolUse'),
      { AGENT_PEERS_HOME: home },
    )
    expect(out).toEqual({ stdout: '{}\n', stderr: '', exitCode: 0 })
    expect(await logOf(home)).toContain('hook PreToolUse (abc123): not_connected')
  })

  it('command hooks of other agents are no-ops', async () => {
    const io = memoryIo({ AGENT_PEERS_HOME: dir }, '{}')
    expect(await main(['hook', 'Stop', '--agent', 'codex'], io)).toBe(0)
    expect(io.out.join('')).toBe('{}\n')
    expect(await logOf(dir)).toContain('agent codex does not use command hooks')
  })

  it('answers {} when reading stdin fails', async () => {
    const io = {
      ...memoryIo({ AGENT_PEERS_HOME: dir }),
      readStdin: () => Promise.reject(new Error('stdin exploded')),
    }
    expect(await runHookCommand('stop', { agent: 'claude-code' }, io)).toBe(0)
    expect(io.out.join('')).toBe('{}\n')
    expect(await logOf(dir)).toContain('stdin exploded')
  })

  it('passes the waiter options through and rejects a bad --timeout', async () => {
    const io = memoryIo({ AGENT_PEERS_HOME: dir }, await fixture('Stop'))
    const code = await main(['hook', 'stop', '--wait', '--timeout', '10'], io, {
      hook: { waiter: { reconnectWindowMs: 50, retryMs: 10 } },
    })
    expect(code).toBe(0)
    expect(await logOf(dir)).toContain('waiter: bridge unreachable')
    const bad = memoryIo({ AGENT_PEERS_HOME: dir })
    expect(await main(['hook', 'stop', '--timeout', 'soon'], bad)).toBe(1)
    expect(bad.err.join('')).toContain('expected a number of seconds')
  })
})

describe('cli program', () => {
  it('prints its version and help, and fails on unknown commands', async () => {
    const io = memoryIo({})
    expect(await main(['--version'], io)).toBe(0)
    expect(io.out.join('')).toMatch(/^\d+\.\d+\.\d+\n$/)
    const unknown = memoryIo({})
    expect(await main(['teleport'], unknown)).toBe(2)
    expect(unknown.err.join('')).toContain("unknown command 'teleport'")
  })
})

describe('readStream', () => {
  const streamOf = (chunks: readonly string[], keepOpen = false) =>
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk))
        if (!keepOpen) controller.close()
      },
    })

  it('reads all chunks, caps the size and gives up on a pipe left open', async () => {
    expect(await readStream(streamOf(['{"a":', '1}']))).toBe('{"a":1}')
    await expect(readStream(streamOf(['x'.repeat(20)]), { maxBytes: 10 })).rejects.toThrow('exceeds 10 bytes')
    expect(await readStream(streamOf(['partial'], true), { timeoutMs: 50 })).toBe('partial')
  })

  it('process io writes to the real streams', () => {
    expect(() => {
      processIo.stdout('')
      processIo.stderr('')
    }).not.toThrow()
    expect(processIo.env).toBe(process.env)
  })
})
