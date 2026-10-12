import { describe, expect, it } from 'bun:test'
import { parse } from 'smol-toml'
import {
  addApprovals,
  approvalModes,
  parseConfig,
  peersHooksTrusted,
  pluginEnabled,
  removeApprovals,
} from '../src/install/codex-config'

const USER_CONFIG = `# my codex config
model = "gpt-6"

[plugins."peers@agent-peers"]
enabled = true # set by codex plugin add
`

describe('codex config.toml approvals', () => {
  it('appends the approval block and keeps comments', () => {
    const edit = addApprovals(USER_CONFIG)
    expect(edit.changed).toBe(true)
    expect(edit.text.startsWith(USER_CONFIG)).toBe(true)
    expect(edit.text).toMatchSnapshot()
    expect(approvalModes(parse(edit.text))).toEqual({ peers_reply: 'approve', peers_progress: 'approve' })
  })

  it('is idempotent and round-trips through remove', () => {
    const added = addApprovals(USER_CONFIG).text
    expect(addApprovals(added)).toEqual({ text: added, changed: false, kept: [] })
    const removed = removeApprovals(added)
    expect(removed.changed).toBe(true)
    expect(removed.text).toBe(USER_CONFIG)
    expect(removeApprovals(USER_CONFIG).changed).toBe(false)
  })

  it('works on an empty or missing file and one without a trailing newline', () => {
    const fromEmpty = addApprovals('')
    expect(fromEmpty.text.startsWith('# agent-peers')).toBe(true)
    expect(removeApprovals(fromEmpty.text).text).toBe('')
    const noNewline = addApprovals('model = "x"')
    expect(noNewline.text.startsWith('model = "x"\n\n#')).toBe(true)
  })

  it('keeps an approval_mode the user chose and only adds the missing one', () => {
    const text = `[plugins."peers@agent-peers".mcp_servers.peers.tools.peers_reply]\napproval_mode = "prompt"\n`
    const edit = addApprovals(text)
    expect(edit.kept).toEqual(['peers_reply'])
    expect(approvalModes(parse(edit.text))).toEqual({ peers_reply: 'prompt', peers_progress: 'approve' })
    expect(removeApprovals(edit.text).text).toBe(text)
  })

  it('re-serializes when the tables already exist in another shape', () => {
    const text = `[plugins."peers@agent-peers".mcp_servers.peers.tools.peers_reply]\nenabled = true\n`
    const edit = addApprovals(text)
    expect(edit.changed).toBe(true)
    expect(edit.text).toMatchSnapshot()
    expect(approvalModes(parse(edit.text)).peers_reply).toBe('approve')
    const removed = removeApprovals(edit.text)
    expect(approvalModes(parse(removed.text))).toEqual({ peers_reply: undefined, peers_progress: undefined })
    expect(parse(removed.text)).toEqual({
      plugins: {
        'peers@agent-peers': { mcp_servers: { peers: { tools: { peers_reply: { enabled: true } } } } },
      },
    })
  })

  it('refuses invalid TOML instead of overwriting it', () => {
    expect(() => addApprovals('this is = = not toml')).toThrow('config.toml is not valid TOML')
    expect(() => parseConfig('[[')).toThrow()
  })
})

describe('codex config.toml status', () => {
  it('reads plugin enablement and hook trust', () => {
    const config = parse(
      `${USER_CONFIG}\n[hooks.state."peers@agent-peers:PreToolUse:0"]\nenabled = true\ntrusted_hash = "abc"\n`,
    )
    expect(pluginEnabled(config)).toBe(true)
    expect(peersHooksTrusted(config)).toBe(true)
    expect(pluginEnabled({})).toBeUndefined()
    expect(peersHooksTrusted({})).toBe(false)
    expect(peersHooksTrusted(parse('[hooks.state."other@x:Stop:0"]\ntrusted_hash = "a"\n'))).toBe(false)
  })
})
