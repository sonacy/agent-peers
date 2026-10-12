import { describe, expect, it } from 'bun:test'
import {
  AUTO_APPROVED_TOOLS,
  CLAUDE_HOOK_COMMANDS,
  CODEX_HOOK_EVENTS,
  claudeCodeToolName,
  codexToolName,
  HOOK_TOOL_NAME,
  NEVER_AUTO_APPROVED_TOOLS,
  PEER_TURN_DENIED_TOOLS,
  PEERS_COMMANDS,
  PEERS_TOOL_NAMES,
  PEERS_TOOLS,
} from '../../adapters/tools'
import { validateCommandTools } from '../../adapters/validate-shared'

describe('canonical tool list', () => {
  it('has unique peers_* names', () => {
    expect(new Set(PEERS_TOOL_NAMES).size).toBe(PEERS_TOOL_NAMES.length)
    for (const name of PEERS_TOOL_NAMES) expect(name).toMatch(/^peers_[a-z]+$/)
  })

  it('maps every command to exactly one user tool and covers every user tool', () => {
    const commandTools = PEERS_COMMANDS.map((command) => command.tool)
    const userTools = PEERS_TOOLS.filter((tool) => tool.audience === 'user').map((tool) => tool.name)
    expect(new Set(commandTools).size).toBe(commandTools.length)
    expect([...commandTools].sort()).toEqual([...userTools].sort())
    expect(validateCommandTools(PEERS_COMMANDS)).toEqual([])
  })

  it('lists the assigned commands', () => {
    expect(PEERS_COMMANDS.map((command) => command.name).sort()).toEqual(
      [
        'ask',
        'dashboard',
        'inbox',
        'invite',
        'join',
        'knock',
        'leave',
        'listen',
        'rename',
        'room',
        'say',
        'status',
        'who',
      ].sort(),
    )
    const userOnly = PEERS_COMMANDS.filter((command) => command.userOnly).map((command) => command.name)
    expect(userOnly.sort()).toEqual(['dashboard', 'invite', 'join', 'knock', 'leave', 'room'])
  })

  it('keeps approval and peer-turn sets consistent with the spec', () => {
    const known = new Set(PEERS_TOOL_NAMES)
    for (const name of [...AUTO_APPROVED_TOOLS, ...NEVER_AUTO_APPROVED_TOOLS, ...PEER_TURN_DENIED_TOOLS]) {
      expect(known.has(name)).toBe(true)
    }
    expect(AUTO_APPROVED_TOOLS.filter((name) => NEVER_AUTO_APPROVED_TOOLS.includes(name))).toEqual([])
    expect(AUTO_APPROVED_TOOLS.filter((name) => PEER_TURN_DENIED_TOOLS.includes(name))).toEqual([])
    expect(PEERS_TOOLS.find((tool) => tool.name === HOOK_TOOL_NAME)?.audience).toBe('hook')
  })

  it('builds the scoped MCP tool names each agent uses', () => {
    expect(claudeCodeToolName('peers_reply')).toBe('mcp__plugin_peers_peers__peers_reply')
    expect(codexToolName('peers_reply')).toBe('mcp__peers__peers_reply')
  })

  it('names the hook commands and events', () => {
    expect(CLAUDE_HOOK_COMMANDS).toContain('wait')
    expect(CODEX_HOOK_EVENTS).toEqual(['SessionStart', 'UserPromptSubmit', 'Stop', 'PreToolUse'])
  })

  it('reports commands whose tool is unknown or not user-facing', () => {
    const base = { argumentHint: '', description: 'd', argumentGuide: 'g', userOnly: false }
    const bad = [
      { ...base, name: 'x', tool: 'peers_nope' },
      { ...base, name: 'y', tool: 'peers_reply' },
    ]
    expect(validateCommandTools(bad)).toEqual([
      'command x: peers_nope is not a peers MCP tool',
      'command y: peers_reply is not a user tool',
    ])
  })
})
