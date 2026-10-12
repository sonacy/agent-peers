import { afterAll, describe, expect, it, mock } from 'bun:test'

const calls: unknown[] = []
let answer: unknown = ['claude-code']
const CANCEL = Symbol('clack:cancel')

mock.module('@clack/prompts', () => ({
  multiselect: async (options: unknown) => {
    calls.push(options)
    return answer
  },
  isCancel: (value: unknown) => value === CANCEL,
}))

const { clackPrompt } = await import('../src/commands/add-select')

afterAll(() => {
  mock.restore()
})

describe('clackPrompt (the interactive agent picker)', () => {
  it('maps options, greys out unsupported agents and pre-checks earlier picks', async () => {
    answer = ['claude-code']
    const picked = await clackPrompt(
      [
        { value: 'claude-code', label: 'Claude Code', hint: '2.1.296' },
        { value: 'codex', label: 'Codex CLI', hint: 'needs 0.157 or later', disabled: true },
        { value: 'claude-desktop', label: 'Claude Desktop' },
      ],
      ['claude-code'],
    )
    expect(picked).toEqual(['claude-code'])
    expect(calls.at(-1)).toEqual({
      message: 'Install agent-peers into which agents?',
      options: [
        { value: 'claude-code', label: 'Claude Code', hint: '2.1.296' },
        { value: 'codex', label: 'Codex CLI', hint: 'needs 0.157 or later', disabled: true },
        { value: 'claude-desktop', label: 'Claude Desktop' },
      ],
      initialValues: ['claude-code'],
      required: false,
    })
  })

  it('returns undefined when the user cancels', async () => {
    answer = CANCEL
    expect(await clackPrompt([{ value: 'codex', label: 'Codex CLI' }], [])).toBeUndefined()
  })
})
