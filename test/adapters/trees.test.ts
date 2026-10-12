/** Parses every committed manifest, hook and skill file and checks it against the canonical lists. */
import { describe, expect, it } from 'bun:test'
import { join } from 'node:path'
import { PEERS_COMMANDS, PEERS_TOOL_NAMES } from '../../adapters/tools'
import { validateAdapters } from '../../adapters/validate'
import { CLAUDE_SHIM_COMMAND } from '../../adapters/validate-claude'
import { isExecutableFile, isObject, parseFrontmatter } from '../../adapters/validate-common'
import { ADAPTERS_DIR, readJson } from './helpers'

type Handler = { [key: string]: unknown }

const handlers = (events: unknown, event: string): readonly Handler[] => {
  const groups = isObject(events) && Array.isArray(events[event]) ? (events[event] as unknown[]) : []
  return groups.flatMap((group) =>
    isObject(group) && Array.isArray(group.hooks) ? (group.hooks as Handler[]) : [],
  )
}

const claudeBin = Bun.which('claude')

describe('committed adapter trees', () => {
  it('pass every structural check, and generated files are current', async () => {
    expect(await validateAdapters(ADAPTERS_DIR)).toEqual([])
  })

  it('Claude Code hooks all invoke the shim with hook <event> --agent claude-code', async () => {
    const config = await readJson(join(ADAPTERS_DIR, 'claude-code/hooks/hooks.json'))
    const events = config.hooks
    const all = Object.keys(events as object).flatMap((event) => handlers(events, event))
    expect(all.length).toBeGreaterThan(0)
    for (const handler of all) {
      expect(handler.command).toBe(CLAUDE_SHIM_COMMAND)
      expect((handler.args as string[]).slice(0, 1)).toEqual(['hook'])
      expect((handler.args as string[]).slice(2)).toEqual(['--agent', 'claude-code'])
    }
  })

  it('arms the asyncRewake waiter on SessionStart, Stop and StopFailure', async () => {
    const { hooks } = await readJson(join(ADAPTERS_DIR, 'claude-code/hooks/hooks.json'))
    for (const event of ['SessionStart', 'Stop', 'StopFailure']) {
      const waiter = handlers(hooks, event).find((handler) => (handler.args as string[])[1] === 'wait')
      expect(waiter).toMatchObject({ async: true, asyncRewake: true })
      expect(waiter?.timeout as number).toBeGreaterThanOrEqual(3600)
    }
  })

  it('every skill names an existing MCP tool', async () => {
    for (const tree of ['claude-code', 'codex']) {
      for (const command of PEERS_COMMANDS) {
        const text = await Bun.file(join(ADAPTERS_DIR, tree, 'skills', command.name, 'SKILL.md')).text()
        const tools = [...text.matchAll(/`(peers_[a-z]+)`/g)].map((match) => match[1])
        expect(tools).toEqual([command.tool])
        expect(PEERS_TOOL_NAMES).toContain(command.tool)
        expect(parseFrontmatter(text)).toBeDefined()
      }
    }
  })

  it('Codex hooks call the hidden peers_hook tool on the peers server', async () => {
    const manifest = await readJson(join(ADAPTERS_DIR, 'codex/.codex-plugin/plugin.json'))
    const events = isObject(manifest.hooks) ? manifest.hooks.hooks : undefined
    for (const event of ['SessionStart', 'UserPromptSubmit', 'Stop', 'PreToolUse']) {
      const [handler] = handlers(events, event)
      expect(handler).toMatchObject({ type: 'mcp_tool', server: 'peers', tool: 'peers_hook' })
    }
    const mcp = await readJson(join(ADAPTERS_DIR, 'codex/mcp.json'))
    expect(mcp).toMatchObject({
      mcpServers: { peers: { command: './bin/agent-peers', args: ['mcp', '--surface', 'codex'] } },
    })
  })

  it('ships identical, executable shims in both plugins', async () => {
    const claude = join(ADAPTERS_DIR, 'claude-code/bin/agent-peers')
    const codex = join(ADAPTERS_DIR, 'codex/bin/agent-peers')
    expect(await isExecutableFile(claude)).toBe(true)
    expect(await isExecutableFile(codex)).toBe(true)
    expect(await Bun.file(codex).text()).toBe(await Bun.file(claude).text())
  })

  it.skipIf(!claudeBin)('passes `claude plugin validate --strict` (read-only)', () => {
    for (const target of ['claude-code', 'marketplace']) {
      const result = Bun.spawnSync(
        [claudeBin ?? 'claude', 'plugin', 'validate', '--strict', join(ADAPTERS_DIR, target)],
        {
          stdout: 'pipe',
          stderr: 'pipe',
        },
      )
      const output = `${result.stdout.toString()}${result.stderr.toString()}`
      expect({ target, exitCode: result.exitCode, output }).toMatchObject({ target, exitCode: 0 })
    }
  })
})
