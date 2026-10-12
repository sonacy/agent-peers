import { describe, expect, it } from 'bun:test'
import {
  estimateLines,
  inlineRuns,
  linkify,
  shouldCollapse,
  splitCodeBlocks,
} from '../../src/lib/format/message'

describe('splitCodeBlocks', () => {
  it('splits fenced code with and without a language', () => {
    expect(splitCodeBlocks('看这里：\n```ts\nconst a = 1\n```\n就这样')).toEqual([
      { kind: 'text', text: '看这里：\n' },
      { kind: 'code', text: 'const a = 1', lang: 'ts' },
      { kind: 'text', text: '\n就这样' },
    ])
    expect(splitCodeBlocks('```\nx\n```')).toEqual([{ kind: 'code', text: 'x' }])
  })
  it('runs an unclosed fence to the end and drops blank text', () => {
    expect(splitCodeBlocks('a\n```\nb')).toEqual([
      { kind: 'text', text: 'a\n' },
      { kind: 'code', text: 'b' },
    ])
    expect(splitCodeBlocks('  ')).toEqual([])
    expect(splitCodeBlocks('plain')).toEqual([{ kind: 'text', text: 'plain' }])
  })
})

describe('linkify', () => {
  it('finds http(s) links and leaves trailing punctuation as text', () => {
    expect(linkify('见 https://a.example/x?y=1。然后')).toEqual([
      { kind: 'text', text: '见 ' },
      { kind: 'link', text: 'https://a.example/x?y=1' },
      { kind: 'text', text: '。然后' },
    ])
    expect(linkify('javascript:alert(1)')).toEqual([{ kind: 'text', text: 'javascript:alert(1)' }])
    expect(linkify('http://x.io')).toEqual([{ kind: 'link', text: 'http://x.io' }])
  })
})

describe('collapse rule', () => {
  it('collapses past 8 estimated lines', () => {
    expect(estimateLines('a\nb')).toBe(2)
    expect(estimateLines('x'.repeat(100), 48)).toBe(3)
    expect(shouldCollapse(Array.from({ length: 8 }, () => 'line').join('\n'))).toBe(false)
    expect(shouldCollapse(Array.from({ length: 9 }, () => 'line').join('\n'))).toBe(true)
    expect(shouldCollapse('字'.repeat(48 * 9))).toBe(true)
  })
})

describe('inlineRuns', () => {
  it('takes backtick spans as code, then links the text between them', () => {
    expect(inlineRuns('带 `X-Signature` 见 https://a.example/x')).toEqual([
      { kind: 'text', text: '带 ' },
      { kind: 'code', text: 'X-Signature' },
      { kind: 'text', text: ' 见 ' },
      { kind: 'link', text: 'https://a.example/x' },
    ])
  })
  it('keeps a URL inside backticks as code and leaves lone or empty backticks alone', () => {
    expect(inlineRuns('`https://a.example`')).toEqual([{ kind: 'code', text: 'https://a.example' }])
    expect(inlineRuns('a ` b')).toEqual([{ kind: 'text', text: 'a ` b' }])
    expect(inlineRuns('``')).toEqual([{ kind: 'text', text: '``' }])
    expect(inlineRuns('`a\nb`')).toEqual([{ kind: 'text', text: '`a\nb`' }])
  })
})
