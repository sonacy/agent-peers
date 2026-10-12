import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { join } from 'node:path'
import { INERT_INSTRUCTIONS } from '../src/surface/instructions'
import { startWorld, type World } from './helpers/world'

let world: World

beforeEach(async () => {
  world = await startWorld()
})
afterEach(async () => {
  await world.stop()
})

describe('surface mismatch (ARCHITECTURE §6.2)', () => {
  it('Claude Desktop config loaded into the Code tab: no tools, no hub, inert instructions', async () => {
    const desk = await world.bridge('claude-desktop', {
      token: world.member('fay'),
      clientInfo: { name: 'claude-code', version: '2.1.296' },
    })
    expect(desk.bridge.verdict?.ok).toBe(false)
    expect(await desk.tools()).toEqual([])
    expect(desk.client.getInstructions()).toBe(INERT_INSTRUCTIONS)
    const refused = await desk.call('peers_who')
    expect(refused.isError).toBe(true)
    expect(refused.text).toContain('forbidden')
    expect(desk.bridge.runtime).toBeUndefined()
    expect(desk.logs.join('\n')).toContain('inactive: loaded by claude-code')
  })

  it('a Claude plugin imported by Cursor binds no control socket', async () => {
    const cc = await world.bridge('claude-code', {
      token: world.member('gus'),
      clientInfo: { name: 'cursor-vscode', version: '1.0.0' },
      env: { CLAUDE_CODE_SESSION_ID: 'cc-cursor' },
      controlSocket: { runDir: join(world.dir, 'run-cursor'), pid: 4999, ancestorPids: [4999] },
    })
    expect(cc.bridge.verdict?.client).toBe('cursor')
    expect(cc.bridge.controlSocketPath).toBeUndefined()
    expect(await cc.tools()).toEqual([])
  })

  it('an unknown client is accepted only with a matching environment', async () => {
    const unknown = await world.bridge('claude-code', { clientInfo: { name: 'inspector', version: '1' } })
    expect(unknown.bridge.verdict?.ok).toBe(false)
    const envOk = await world.bridge('claude-code', {
      clientInfo: { name: 'inspector', version: '1' },
      env: { CLAUDECODE: '1' },
    })
    expect(envOk.bridge.verdict?.ok).toBe(true)
    const forced = await world.bridge('codex', {
      clientInfo: { name: 'inspector', version: '1' },
      env: { AGENT_PEERS_SURFACE_CHECK: 'off' },
    })
    expect(forced.bridge.verdict?.reason).toBe('surface check disabled')
    expect(await forced.tools()).toHaveLength(16)
  })

  it('unknown tools are refused once active', async () => {
    const desk = await world.bridge('claude-desktop')
    const out = await desk.call('peers_nope')
    expect(out.text).toContain('method_not_found')
  })
})
