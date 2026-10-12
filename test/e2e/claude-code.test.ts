/**
 * Claude Code (plugin `peers`): the bridge runs `--surface claude-code`; hooks reach it over the
 * control socket; asks wake an idle session through the asyncRewake waiter (exit 2).
 */
import { afterEach, describe, expect, it } from 'bun:test'
import type { ClaudeCodeAgent } from './support/agents'
import { hookJson } from './support/claude-hooks'
import { runLifecycle, type SurfaceSteps } from './support/lifecycle'
import { createWorld, type World } from './support/world'

let world: World | undefined
afterEach(async () => {
  await world?.cleanup()
  world = undefined
})

const asClaude = (agent: unknown) => agent as ClaudeCodeAgent

/** ARCHITECTURE §8: during the injected turn writes are denied, reads in the workspace allowed. */
async function gateChecks(agent: ClaudeCodeAgent, askId: string | undefined): Promise<void> {
  const write = hookJson(
    await agent.hook('PreToolUse', {
      tool_name: 'Write',
      tool_input: { file_path: `${agent.machine.workspace}/notes.md`, content: 'pwned' },
    }),
  )
  expect(write).toMatchObject({ hookSpecificOutput: { permissionDecision: 'deny' } })
  const shell = hookJson(await agent.hook('PreToolUse', {}))
  expect(shell).toMatchObject({ hookSpecificOutput: { permissionDecision: 'deny' } })
  const read = hookJson(
    await agent.hook('PreToolUse', {
      tool_name: 'Read',
      tool_input: { file_path: `${agent.machine.workspace}/README.md` },
    }),
  )
  expect(read).toEqual({})
  const approve = hookJson(
    await agent.hook('PermissionRequest', {
      tool_name: 'mcp__plugin_peers_peers__peers_reply',
      tool_input: { ask_id: askId, text: 'three retries' },
    }),
  )
  expect(approve).toMatchObject({ hookSpecificOutput: { decision: { behavior: 'allow' } } })
  const relay = await agent.call('peers_send', { text: 'relaying the question to everyone' })
  expect(relay.isError).toBe(true)
  expect(relay.text).toContain('forbidden')
}

const steps: SurfaceSteps = {
  tier: 'push',
  async preJoin(agent) {
    // SessionStart with no credentials: the hooks stay silent (`{}`, exit 0) and log instead.
    const run = await asClaude(agent).hook('SessionStart', { source: 'startup' })
    expect(run.exitCode).toBe(0)
    expect(hookJson(run)).toEqual({})
    asClaude(agent).arm('SessionStart', { source: 'startup' })
  },
  resume: (agent) => agent.start('resume'),
  receiveQueued: (agent) => agent.receive(),
  duringPeerTurn: (agent, delivery) => gateChecks(asClaude(agent), delivery.askId),
}

describe('e2e: Claude Code lifecycle', () => {
  it('start → join → ask via asyncRewake → reply → rename → offline → resume → queued ask → close', async () => {
    world = await createWorld()
    await runLifecycle(world, 'claude-code', {
      steps,
      async extra({ agent }) {
        // Outside a peer turn the gate is out of the way.
        const write = hookJson(
          await asClaude(agent).hook('PreToolUse', {
            tool_name: 'Write',
            tool_input: { file_path: `${agent.machine.workspace}/notes.md`, content: 'ok' },
          }),
        )
        expect(write).toEqual({})
      },
    })
  }, 120_000)
})
