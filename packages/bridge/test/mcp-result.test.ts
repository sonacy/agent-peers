import { describe, expect, it } from 'bun:test'
import { toCallResult } from '../src/mcp/server'

// Live regression (test/live/claude-code.live.test.ts): Claude Code feeds the model a tool's
// structuredContent instead of its text block, so the text must be part of the structured payload.
describe('toCallResult', () => {
  it('repeats the text inside structuredContent so clients that prefer it lose nothing', () => {
    const out = toCallResult({ text: 'reply from @bot: 4', structured: { ask_id: 'a1', state: 'answered' } })
    expect(out.content).toEqual([{ type: 'text', text: 'reply from @bot: 4' }])
    expect(out.structuredContent).toEqual({ text: 'reply from @bot: 4', ask_id: 'a1', state: 'answered' })
    expect(out.isError).toBeUndefined()
  })

  it('keeps hook output (peers_hook) and text-only results unchanged', () => {
    const hook = toCallResult({ text: '{"decision":"block"}', structured: { decision: 'block' } }, false)
    expect(hook.structuredContent).toEqual({ decision: 'block' })
    const plain = toCallResult({ text: 'nothing changed' })
    expect(plain.structuredContent).toBeUndefined()
  })

  it('marks errors and keeps their code', () => {
    const out = toCallResult({
      text: 'agent-peers error x',
      structured: { error: { code: 'x' } },
      isError: true,
    })
    expect(out.isError).toBe(true)
    expect(out.structuredContent).toEqual({ text: 'agent-peers error x', error: { code: 'x' } })
  })
})
