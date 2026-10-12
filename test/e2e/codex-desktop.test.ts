/**
 * Codex desktop (ChatGPT.app): the same plugin as the CLI (`--surface codex`), told apart at runtime
 * by the app-server's environment; it pushes through the bundled engine's `codex queue` (a fake CLI
 * at CODEX_CLI_PATH here) and advertises `codex-desktop` on its card.
 */
import { afterEach, describe, expect, it } from 'bun:test'
import { codexSteps } from './support/codex-steps'
import { asCodex, runLifecycle } from './support/lifecycle'
import { createWorld, type World } from './support/world'

let world: World | undefined
afterEach(async () => {
  await world?.cleanup()
  world = undefined
})

describe('e2e: Codex desktop lifecycle', () => {
  it('start → join → ask via codex queue → reply → rename → offline → resume → queued ask → close', async () => {
    world = await createWorld()
    await runLifecycle(world, 'codex-desktop', {
      steps: codexSteps,
      async extra({ agent }) {
        // Every queued envelope went to this thread through the desktop engine.
        const calls = await agent.machine.queueCalls()
        expect(calls.length).toBeGreaterThan(0)
        expect(calls.every((c) => c.thread === asCodex(agent).key)).toBe(true)
      },
    })
  }, 120_000)
})
