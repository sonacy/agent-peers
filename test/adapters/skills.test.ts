import { describe, expect, it } from 'bun:test'
import {
  renderClaudeSkill,
  renderCodexSkill,
  renderCodexSkillPolicy,
  skillFiles,
} from '../../adapters/skills'
import { PEERS_COMMANDS, type PeersCommand } from '../../adapters/tools'
import { isContainedCommand, parseFrontmatter } from '../../adapters/validate-common'

const command = (name: string): PeersCommand => {
  const found = PEERS_COMMANDS.find((candidate) => candidate.name === name)
  if (!found) throw new Error(`no command ${name}`)
  return found
}

describe('skill rendering', () => {
  it('renders Claude Code skills with $ARGUMENTS and quoted YAML', () => {
    const parsed = parseFrontmatter(renderClaudeSkill(command('ask')))
    expect(parsed?.fields.description).toBe(command('ask').description)
    expect(parsed?.fields['argument-hint']).toBe('@handle[@room] <question> [--write]')
    expect(parsed?.fields['disable-model-invocation']).toBeUndefined()
    expect(parsed?.body).toContain('`peers_ask`')
    expect(parsed?.body).toContain('Arguments: $ARGUMENTS')
    expect(parsed?.body).toContain('untrusted')
  })

  it('disables model invocation for side-effecting commands', () => {
    const parsed = parseFrontmatter(renderClaudeSkill(command('join')))
    expect(parsed?.fields['disable-model-invocation']).toBe(true)
  })

  it('omits argument-hint when a command takes no arguments', () => {
    const parsed = parseFrontmatter(renderClaudeSkill(command('inbox')))
    expect(parsed?.fields['argument-hint']).toBeUndefined()
  })

  it('renders Codex skills with a name and no $ARGUMENTS placeholder', () => {
    const text = renderCodexSkill(command('ask'))
    const parsed = parseFrontmatter(text)
    expect(parsed?.fields.name).toBe('ask')
    expect(text).not.toContain('$ARGUMENTS')
    expect(text).toContain('$peers:ask @handle[@room]')
    expect(renderCodexSkill(command('inbox'))).toContain('`$peers:inbox`')
  })

  it('emits a Codex implicit-invocation policy only for user-only commands', () => {
    const files = skillFiles()
    const policies = files.filter((file) => file.path.endsWith('agents/openai.yaml'))
    expect(policies.map((file) => file.path.split('/')[2]).sort()).toEqual(
      PEERS_COMMANDS.filter((c) => c.userOnly)
        .map((c) => c.name)
        .sort(),
    )
    expect(renderCodexSkillPolicy()).toBe('policy:\n  allow_implicit_invocation: false\n')
    expect(files).toHaveLength(PEERS_COMMANDS.length * 2 + policies.length)
  })
})

describe('frontmatter parser', () => {
  it('parses plain, boolean and quoted values', () => {
    const parsed = parseFrontmatter('---\nname: ask\nflag: false\ndesc: "a: [b]"\n---\nbody\n')
    expect(parsed).toEqual({ fields: { name: 'ask', flag: false, desc: 'a: [b]' }, body: 'body\n' })
  })

  it('rejects missing or malformed frontmatter', () => {
    expect(parseFrontmatter('no frontmatter')).toBeUndefined()
    expect(parseFrontmatter('---\nnot a pair\n---\n')).toBeUndefined()
    expect(parseFrontmatter('---\nkey: "unterminated\n---\n')).toBeUndefined()
    expect(parseFrontmatter('---\nkey: "1"x\n---\n')).toBeUndefined()
  })
})

describe('contained commands (Codex MCP launch rule)', () => {
  it('accepts bare names and ./ paths inside the plugin', () => {
    expect(isContainedCommand('agent-peers')).toBe(true)
    expect(isContainedCommand('./bin/agent-peers')).toBe(true)
  })

  it('rejects absolute paths, traversal and dot names', () => {
    expect(isContainedCommand('/usr/local/bin/agent-peers')).toBe(false)
    expect(isContainedCommand('./bin/../../x')).toBe(false)
    expect(isContainedCommand('..')).toBe(false)
    expect(isContainedCommand('.//x')).toBe(false)
  })
})
