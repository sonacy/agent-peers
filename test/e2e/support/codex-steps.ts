/** Lifecycle steps shared by the Codex CLI and Codex desktop surfaces. */
import { expect } from 'bun:test'
import type { Agent, Delivery } from './agents'
import { asCodex, type SurfaceSteps } from './lifecycle'

/** The peer-turn gate through peers_hook PreToolUse (ARCHITECTURE §8). */
export async function codexGate(agent: Agent): Promise<void> {
  const codex = asCodex(agent)
  const patch = await codex.hook('PreToolUse', {
    tool_name: 'apply_patch',
    tool_input: JSON.stringify({ input: '*** Begin Patch\n*** Add File: x.txt\n+pwned\n*** End Patch' }),
  })
  expect(patch).toMatchObject({ hookSpecificOutput: { permissionDecision: 'deny' } })
  const rm = await codex.hook('PreToolUse', { tool_name: 'Bash', tool_input: { command: 'rm -rf build' } })
  expect(rm).toMatchObject({ hookSpecificOutput: { permissionDecision: 'deny' } })
  const cat = await codex.hook('PreToolUse', { tool_name: 'Bash', tool_input: { command: 'cat README.md' } })
  expect(cat).toEqual({})
  const relay = await codex.call('peers_ask', { target: '@asker', question: 'relay this?' })
  expect(relay.isError).toBe(true)
  expect(relay.text).toContain('forbidden')
}

export const codexSteps: SurfaceSteps = {
  tier: 'push',
  initialTier: 'boundary',
  async preJoin(agent) {
    expect(agent.bridge.instructions).toContain('Never call peers_hook')
    // SessionStart before the first join: no hub to register with, so the hook has no opinion.
    expect(await asCodex(agent).hook('SessionStart', { source: 'startup' })).toEqual({})
  },
  resume: (agent) => agent.start('resume'),
  async receiveQueued(agent): Promise<Delivery> {
    // A resumed thread is not known to be idle until its next turn: the envelope waits for the
    // user's next prompt (UserPromptSubmit additionalContext), not `codex queue`.
    const context = await asCodex(agent).prompt('anything new?')
    expect(context).toBeDefined()
    return { envelope: context ?? '', askId: /ask_id (\S+)/.exec(context ?? '')?.[1] }
  },
  duringPeerTurn: (agent) => codexGate(agent),
}
