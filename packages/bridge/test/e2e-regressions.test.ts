/**
 * Regressions found by the simulated-surface e2e matrix (test/e2e):
 * - a Codex `peers_hook` call before the first join answered with a tool error instead of `{}`;
 * - a Codex thread whose `codex queue` probe finished after its first hook kept advertising
 *   `boundary` although the bridge could push.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { join } from 'node:path'
import { CodexQueueInjector } from '../src/injectors/codex/queue-injector'
import { eventually, startWorld, type World } from './helpers/world'
import { writeFakeCodex } from './injectors/fake-codex'

let world: World

beforeEach(async () => {
  world = await startWorld()
})
afterEach(async () => {
  await world.stop()
})

const turn = (threadId: string) => ({ 'x-codex-turn-metadata': { thread_id: threadId, turn_id: 'turn-1' } })

describe('e2e regressions', () => {
  it('peers_hook answers {} before the bridge joined any hub, and logs why', async () => {
    const codex = await world.bridge('codex')
    for (const event of ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'Stop']) {
      const out = await codex.call('peers_hook', {
        agent: 'codex',
        hook_event_name: event,
        session_id: 't-1',
        tool_name: 'Bash',
        tool_input: { command: 'ls' },
      })
      expect(out.isError).toBe(false)
      expect(JSON.parse(out.text)).toEqual({})
    }
    expect(codex.logs.join('\n')).toContain(
      'peers_hook SessionStart: unauthorized: not joined to any hub yet',
    )
    // Argument validation still fails loudly: that is a plugin bug, not a runtime condition.
    const invalid = await codex.call('peers_hook', { hook_event_name: 42 })
    expect(invalid.isError).toBe(true)
  })

  it('re-advertises push once a late codex probe succeeds', async () => {
    const fake = await writeFakeCodex(join(world.dir, 'bin'))
    const release = Promise.withResolvers<void>()
    const injector = new CodexQueueInjector({
      env: { CODEX_CLI_PATH: fake.path },
      surface: 'codex',
      resolve: async () => {
        await release.promise
        return { path: fake.path, source: 'env' }
      },
    })
    const alice = await world.peer('alice')
    const room = await world.room(alice, 'team', 'home')
    const codex = await world.bridge('codex', { token: world.member('dave'), injector })
    expect((await codex.call('peers_join', { invite: room.code, handle: 'work' }, turn('t-1'))).isError).toBe(
      false,
    )
    const stop = await codex.call('peers_hook', {
      agent: 'codex',
      hook_event_name: 'Stop',
      session_id: 't-1',
    })
    expect(stop.isError).toBe(false)
    const tierOf = async () =>
      (await alice.session.peers(room.roomId)).members.find((m) => m.handle === 'work')?.card.inject
    expect(await eventually(async () => ((await tierOf()) === 'boundary' ? 'boundary' : undefined))).toBe(
      'boundary',
    )
    release.resolve()
    // The probe passing is not enough: the first successful `codex queue` confirms the thread.
    await eventually(() => (injector.probeState().status === 'ok' ? true : undefined))
    await alice.session.ask({ room_id: room.roomId, to: 'work', text: 'are you there?' })
    expect(await eventually(async () => ((await tierOf()) === 'push' ? 'push' : undefined))).toBe('push')
  })

  it('notifies tier listeners when a probe finishes, until they unsubscribe', async () => {
    const fake = await writeFakeCodex(join(world.dir, 'bin'))
    const injector = new CodexQueueInjector({ env: { CODEX_CLI_PATH: fake.path }, surface: 'codex' })
    await injector.probe('cli')
    let kept = 0
    let dropped = 0
    injector.onTierChange(() => {
      kept += 1
    })
    const off = injector.onTierChange(() => {
      dropped += 1
    })
    off()
    await injector.probe('desktop')
    // The constructor's own `cli` probe may still be finishing and notify too.
    expect(kept).toBeGreaterThanOrEqual(1)
    expect(dropped).toBe(0)
  })
})
