/**
 * Claude Desktop chat (`--surface claude-desktop`): poll tier, one session per app
 * (`claude-desktop@<host>`), no hooks. Asks reach the model through peers_inbox (checked at the start
 * of every turn, per the server instructions) or peers_wait (listen mode).
 */
import { afterEach, describe, expect, it } from 'bun:test'
import { asDesktop, runLifecycle, type SurfaceSteps } from './support/lifecycle'
import { createWorld, type World } from './support/world'

let world: World | undefined
afterEach(async () => {
  await world?.cleanup()
  world = undefined
})

const steps: SurfaceSteps = {
  tier: 'poll',
  async preJoin(agent) {
    expect(agent.bridge.instructions).toContain('call peers_inbox once')
    asDesktop(agent).mode = 'inbox'
  },
  async resume(agent) {
    asDesktop(agent).mode = 'wait'
  },
  receiveQueued: (agent) => agent.receive(),
}

describe('e2e: Claude Desktop lifecycle', () => {
  it('start → join → ask via peers_inbox → reply → rename → offline → resume → queued ask via peers_wait → close', async () => {
    world = await createWorld()
    await runLifecycle(world, 'claude-desktop', {
      steps,
      async extra({ agent }) {
        const call = await agent.call('peers_hook', { hook_event_name: 'Stop', session_id: 'x' })
        expect(call.isError).toBe(true)
        expect(call.text).toContain('forbidden')
        const empty = await agent.ok('peers_inbox')
        expect(empty.text).toContain('inbox: nothing new')
      },
    })
  }, 120_000)
})
