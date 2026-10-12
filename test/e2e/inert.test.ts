/**
 * Surface mismatch (ARCHITECTURE §4, §6.2): a bridge loaded by a client it was not installed for
 * registers no tools, opens no hub connection and binds no control socket.
 * - the Claude Desktop config also loads into the Desktop Code tab (Claude Code);
 * - Cursor imports the Claude Code plugin, MCP server included;
 * - the Codex plugin's server started by another client.
 */
import { afterEach, describe, expect, it } from 'bun:test'
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { startBridge } from './support/bridge'
import type { Machine } from './support/machine'
import type { Surface } from './support/profiles'
import { createWorld, type World } from './support/world'

let world: World | undefined
afterEach(async () => {
  await world?.cleanup()
  world = undefined
})

interface Case {
  readonly name: string
  readonly surface: Surface
  readonly clientInfo: { readonly name: string; readonly version: string }
  readonly env: Readonly<Record<string, string>>
  readonly reason: string
}

const CASES: readonly Case[] = [
  {
    name: 'claude_desktop_config.json loaded by the Desktop Code tab',
    surface: 'claude-desktop',
    clientInfo: { name: 'claude-code', version: '2.1.296' },
    env: { CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: 'tab-1' },
    reason: 'loaded by claude-code, but this bridge was installed for claude-desktop',
  },
  {
    name: 'the Claude Code plugin imported by Cursor',
    surface: 'claude-code',
    clientInfo: { name: 'cursor-vscode', version: '3.20.1' },
    env: { CURSOR_VERSION: '3.20.1' },
    reason: 'loaded by Cursor',
  },
  {
    name: 'the Claude Code plugin with Cursor markers but a Claude-looking client',
    surface: 'claude-code',
    clientInfo: { name: 'claude-code', version: '2.1.296' },
    env: { CURSOR_TRACE_ID: 'abc' },
    reason: 'loaded by Cursor',
  },
  {
    name: 'the Codex plugin server started by Claude Desktop',
    surface: 'codex',
    clientInfo: { name: 'claude-ai', version: '0.14.10' },
    env: {},
    reason: 'loaded by claude-desktop, but this bridge was installed for codex',
  },
  {
    name: 'an unknown MCP client',
    surface: 'claude-desktop',
    clientInfo: { name: 'some-ide', version: '1.0.0' },
    env: {},
    reason: 'unrecognized MCP client',
  },
]

async function runFiles(machine: Machine): Promise<readonly string[]> {
  return (await readdir(join(machine.home, 'run')).catch(() => [] as string[])).filter((f) =>
    /^\d+\.(json|sock)$/.test(f),
  )
}

describe('e2e: surface mismatch makes the bridge inert', () => {
  for (const c of CASES) {
    it(c.name, async () => {
      world = await createWorld()
      const machine = await world.machine('mismatch')
      // Even with a member token on disk, an inert bridge never connects.
      await machine.localHome().setCredential(world.hub.url, {
        member_token: world.hub.hub.services.members.create('mismatch').token,
      })
      const before = (await world.hub.sessions()).length
      const bridge = await startBridge(machine, c.surface, {
        sessionKey: 'k-1',
        clientInfo: c.clientInfo,
        env: c.env,
      })
      try {
        expect(await bridge.toolNames()).toEqual([])
        expect(bridge.instructions).toContain('not active in this client')
        const call = await bridge.call('peers_who')
        expect(call.isError).toBe(true)
        expect(call.text).toContain(c.reason)
        await Bun.sleep(300)
        expect(bridge.stderr()).toContain('inactive:')
        expect(await runFiles(machine)).toEqual([])
        expect((await world.hub.sessions()).length).toBe(before)
      } finally {
        await bridge.close()
      }
    }, 60_000)
  }
})
