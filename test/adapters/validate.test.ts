/** Breaks a temp copy of `adapters/` in specific ways and checks that validation names each problem. */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { chmod, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { validateAdapters, validateMarketplaceManifest } from '../../adapters/validate'
import { validateClaudeHooks, validatePermissionMatcher } from '../../adapters/validate-claude'
import { placeholder, validateCodexHooks } from '../../adapters/validate-codex'
import { readJsonObject } from '../../adapters/validate-common'
import { copyAdapters, editJson, removeDir } from './helpers'

let dir = ''
beforeEach(async () => {
  dir = await copyAdapters()
})
afterEach(async () => {
  await removeDir(dirname(dir))
})

const issues = async (): Promise<string> => (await validateAdapters(dir)).join('\n')

type Json = { [key: string]: unknown }
const at = (value: Json, ...path: (string | number)[]): Json =>
  path.reduce<Json>((node, key) => (node as Record<string | number, Json>)[key] as Json, value)

describe('Claude Code tree problems', () => {
  it('reports manifest, MCP and hook mistakes', async () => {
    await editJson(join(dir, 'claude-code/.claude-plugin/plugin.json'), (m) => {
      m.name = 'agent-peers'
      delete m.version
      delete m.author
    })
    await editJson(join(dir, 'claude-code/.mcp.json'), (m) => {
      at(m, 'mcpServers', 'peers').command = 'agent-peers'
      at(m, 'mcpServers').extra = { command: 'x' }
    })
    await editJson(join(dir, 'claude-code/hooks/hooks.json'), (m) => {
      const stopWaiter = at(m, 'hooks', 'Stop', 0, 'hooks', 1)
      stopWaiter.asyncRewake = false
      stopWaiter.timeout = 60
      at(m, 'hooks', 'UserPromptSubmit', 0, 'hooks', 0).async = true
      at(m, 'hooks', 'PreToolUse', 0, 'hooks', 0).command = '/usr/bin/true'
      at(m, 'hooks', 'SessionStart', 0).matcher = 'startup'
      delete at(m, 'hooks').SessionEnd
    })
    const text = await issues()
    expect(text).toContain('plugin.json: name must be "peers"')
    expect(text).toContain('plugin.json: version is required')
    expect(text).toContain('author.name is required')
    expect(text).toContain('.mcp.json: command must be')
    expect(text).toContain('.mcp.json: only the peers server is expected')
    expect(text).toContain('Stop: waiter needs async + asyncRewake')
    expect(text).toContain('Stop: waiter timeout must be >= 3600s')
    expect(text).toContain('UserPromptSubmit: user-prompt-submit must be synchronous')
    expect(text).toContain('PreToolUse: command must be the shim')
    expect(text).toContain('SessionStart: must fire for every source')
    expect(text).toContain('SessionEnd: must run session-end')
  })

  it('reports skill and shim mistakes', async () => {
    await writeFile(join(dir, 'claude-code/skills/ask/SKILL.md'), 'no frontmatter')
    await writeFile(
      join(dir, 'claude-code/skills/join/SKILL.md'),
      '---\ndescription: x\n---\nCall `peers_join`.\n',
    )
    await rm(join(dir, 'claude-code/skills/who'), { recursive: true })
    await chmod(join(dir, 'claude-code/bin/agent-peers'), 0o644)
    await rm(join(dir, 'codex/bin/agent-peers'))
    const text = await issues()
    expect(text).toContain('claude-code: skills/ask/SKILL.md: missing or malformed frontmatter')
    expect(text).toContain('claude-code: skills/join: must pass $ARGUMENTS')
    expect(text).toContain('claude-code: skills/join: disable-model-invocation must be true')
    expect(text).toContain('claude-code: skills/who/SKILL.md: missing')
    expect(text).toContain('claude-code: bin/agent-peers: must be executable')
    expect(text).toContain('codex: bin/agent-peers: missing')
    expect(text).toContain('claude-code/skills/ask/SKILL.md: stale')
    expect(text).toContain('claude-code/skills/who/SKILL.md: missing (run bun adapters/build.ts)')
  })

  it('reports unreadable JSON', async () => {
    await writeFile(join(dir, 'claude-code/hooks/hooks.json'), '{ nope')
    await writeFile(join(dir, 'claude-code/.mcp.json'), '[]')
    await rm(join(dir, 'claude-code/.claude-plugin/plugin.json'))
    const text = await issues()
    expect(text).toContain('hooks.json: invalid JSON')
    expect(text).toContain('.mcp.json: not an object')
    expect(text).toContain('plugin.json: file not found')
    expect(validateClaudeHooks({})).toEqual(['hooks.json: top-level "hooks" object is required'])
  })

  it('checks that the PermissionRequest matcher auto-approves only reply and progress', () => {
    expect(validatePermissionMatcher('^mcp__plugin_peers_peers__peers_(reply|progress)$')).toEqual([])
    expect(validatePermissionMatcher(undefined)).toEqual([
      'hooks.json PermissionRequest: a matcher is required',
    ])
    expect(validatePermissionMatcher('(')[0]).toContain('invalid matcher regex')
    expect(validatePermissionMatcher('mcp__plugin_peers_peers__.*')[0]).toContain('must match only')
    expect(validatePermissionMatcher('.*')).toContain(
      'hooks.json PermissionRequest: matcher also matches Bash, Write, mcp__other__peers_reply',
    )
  })
})

describe('Codex tree problems', () => {
  it('reports manifest, hook and MCP mistakes', async () => {
    await editJson(join(dir, 'codex/.codex-plugin/plugin.json'), (m) => {
      m.skills = 'skills'
      delete m.interface
      const events = at(m, 'hooks', 'hooks')
      const start = at(events, 'SessionStart', 0, 'hooks', 0)
      at(start, 'input').turn_id = placeholder('turn_id')
      const stop = at(events, 'Stop', 0, 'hooks', 0)
      stop.type = 'command'
      stop.server = 'other'
      delete stop.timeout
      at(stop, 'input').session_id = 'x'
      delete at(events, 'PreToolUse', 0, 'hooks', 0).input
      events.Interrupt = []
    })
    await editJson(join(dir, 'codex/mcp.json'), (m) => {
      at(m, 'mcpServers', 'peers').command = '/abs/agent-peers'
      at(m, 'mcpServers', 'peers').cwd = './'
    })
    await writeFile(join(dir, 'codex/README.md'), '# nothing\n')
    await writeFile(
      join(dir, 'codex/skills/ask/SKILL.md'),
      '---\nname: other\ndescription: d\n---\n`peers_ask` $ARGUMENTS\n',
    )
    await rm(join(dir, 'codex/skills/join/agents'), { recursive: true })
    const text = await issues()
    expect(text).toContain('codex: plugin.json: skills must be "./skills/"')
    expect(text).toContain('interface.displayName is required')
    expect(text).toContain('SessionStart: input.turn_id must be absent')
    expect(text).toContain('Stop: handler type must be "mcp_tool"')
    expect(text).toContain('Stop: server must be "peers"')
    expect(text).toContain('Stop: a timeout is required')
    expect(text).toContain(`Stop: input.session_id must be ${placeholder('session_id')}`)
    expect(text).toContain('PreToolUse: input.agent must be "codex"')
    expect(text).toContain('plugin.json hooks: events must be')
    expect(text).toContain('mcp.json: command must be ./bin/agent-peers')
    expect(text).toContain('mcp.json: command must be a bare name or a contained ./ path')
    expect(text).toContain('mcp.json: leave cwd unset')
    expect(text).toContain('README.md: must document peers_reply approval_mode')
    expect(text).toContain('skills/ask: name must be "ask"')
    expect(text).toContain('skills/ask: Codex does not substitute $ARGUMENTS')
    expect(text).toContain(
      'skills/join: agents/openai.yaml implicit-invocation policy must match userOnly=true',
    )
  })

  it('rejects a hooks/hooks.json file and a missing inline hooks block', async () => {
    await Bun.write(join(dir, 'codex/hooks/hooks.json'), '{}')
    await editJson(join(dir, 'codex/mcp.json'), (m) => {
      delete at(m, 'mcpServers').peers
    })
    const text = await issues()
    expect(text).toContain('hooks/hooks.json: hooks live inline in plugin.json')
    expect(text).toContain('mcp.json: mcpServers.peers is required')
    expect(validateCodexHooks({ hooks: [] })[0]).toContain('inline hooks must be')
    expect(validateCodexHooks({ hooks: { hooks: { SessionStart: [{ hooks: ['x'] }] } } })).toContain(
      'plugin.json hooks SessionStart: handler must be an object',
    )
  })
})

describe('Claude Desktop and marketplace problems', () => {
  it('reports a stale template, instructions and missing README', async () => {
    await editJson(join(dir, 'claude-desktop/claude_desktop_config.template.json'), (m) => {
      at(m, 'mcpServers', 'agent-peers-desktop').args = ['mcp']
    })
    await writeFile(join(dir, 'claude-desktop/server-instructions.md'), 'old\n')
    await rm(join(dir, 'claude-desktop/README.md'))
    const text = await issues()
    expect(text).toContain('claude-desktop: template: args must be mcp --surface claude-desktop')
    expect(text).toContain('claude-desktop: server-instructions.md: out of date')
    expect(text).toContain('claude-desktop: README.md: missing')
  })

  it('reports a wrong marketplace manifest', async () => {
    await editJson(join(dir, 'marketplace/.claude-plugin/marketplace.json'), (m) => {
      m.name = 'other'
      m.plugins = [{ name: 'peers', source: '../claude-code' }]
    })
    const text = await issues()
    expect(text).toContain('marketplace: marketplace.json: name must be "agent-peers"')
    expect(text).toContain('marketplace: marketplace.json: peers source must be ./plugins/peers')
    expect(validateMarketplaceManifest({})).toEqual([
      'marketplace.json: name must be "agent-peers"',
      'marketplace.json: owner.name is required',
      'marketplace.json: must list the "peers" plugin',
      'marketplace.json: peers source must be ./plugins/peers',
    ])
  })

  it('reads JSON objects defensively', async () => {
    await writeFile(join(dir, 'x.json'), '{"a":1}')
    expect(await readJsonObject(join(dir, 'x.json'), 'x')).toEqual({ value: { a: 1 }, issues: [] })
  })
})
