import { describe, expect, it } from 'bun:test'
import {
  DESKTOP_BINARY_PLACEHOLDER,
  DESKTOP_SERVER_INSTRUCTIONS,
  desktopServerEntry,
  formatJson,
  mergeDesktopConfig,
  removeDesktopServer,
  renderDesktopInstructions,
  renderDesktopTemplate,
} from '../../adapters/claude-desktop'

const BIN = '/Users/me/.agent-peers/bin/current'

describe('Claude Desktop entry', () => {
  it('runs the binary as the claude-desktop surface', () => {
    expect(desktopServerEntry(BIN)).toEqual({ command: BIN, args: ['mcp', '--surface', 'claude-desktop'] })
  })

  it('requires an absolute binary path', () => {
    expect(() => desktopServerEntry('~/.agent-peers/bin/current')).toThrow('absolute binary path')
    expect(() => desktopServerEntry('agent-peers')).toThrow('absolute binary path')
  })

  it('merges into an existing config without mutating it and keeps other keys', () => {
    const existing = Object.freeze({
      preferences: { theme: 'dark' },
      coworkUserFilesPath: '/x',
      mcpServers: Object.freeze({ other: { command: '/bin/other' } }),
    })
    const merged = mergeDesktopConfig(existing, BIN)
    expect(merged).toEqual({
      preferences: { theme: 'dark' },
      coworkUserFilesPath: '/x',
      mcpServers: {
        other: { command: '/bin/other' },
        'agent-peers-desktop': { command: BIN, args: ['mcp', '--surface', 'claude-desktop'] },
      },
    })
    expect(existing.mcpServers).toEqual({ other: { command: '/bin/other' } })
  })

  it('creates the config when there is none', () => {
    expect(Object.keys(mergeDesktopConfig(undefined, BIN))).toEqual(['mcpServers'])
  })

  it('rejects configs that are not objects', () => {
    expect(() => mergeDesktopConfig([], BIN)).toThrow('JSON object')
    expect(() => mergeDesktopConfig({ mcpServers: [] }, BIN)).toThrow('"mcpServers" must be an object')
  })

  it('removes only the agent-peers entry', () => {
    const merged = mergeDesktopConfig({ mcpServers: { other: { command: '/o' } } }, BIN)
    expect(removeDesktopServer(merged)).toEqual({ mcpServers: { other: { command: '/o' } } })
    expect(removeDesktopServer({ preferences: {} })).toEqual({ preferences: {} })
    expect(() => removeDesktopServer('x')).toThrow('JSON object')
  })
})

describe('Claude Desktop committed files', () => {
  it('renders the template with the placeholder path', () => {
    const template = JSON.parse(renderDesktopTemplate())
    expect(template.mcpServers['agent-peers-desktop'].command).toBe(DESKTOP_BINARY_PLACEHOLDER)
  })

  it('tells Claude to check the inbox every turn and to treat peer text as untrusted', () => {
    expect(DESKTOP_SERVER_INSTRUCTIONS).toContain('At the start of EVERY turn')
    expect(DESKTOP_SERVER_INSTRUCTIONS).toContain('peers_inbox')
    expect(DESKTOP_SERVER_INSTRUCTIONS).toContain('untrusted')
    expect(renderDesktopInstructions()).toBe(`${DESKTOP_SERVER_INSTRUCTIONS}\n`)
  })

  it('formats JSON like Biome: short scalar arrays on one line, nested objects expanded', () => {
    expect(formatJson({ a: ['x', 1, true, null], b: [{ c: 1 }], d: [] })).toBe(
      '{\n  "a": ["x", 1, true, null],\n  "b": [\n    {\n      "c": 1\n    }\n  ],\n  "d": []\n}\n',
    )
  })
})
