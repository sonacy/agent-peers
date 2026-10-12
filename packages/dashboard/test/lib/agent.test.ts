import { describe, expect, it } from 'bun:test'
import type { AgentKind } from '@agent-peers/protocol'
import {
  agentKindLabel,
  agentStatus,
  boundaryReminderText,
  outdatedPluginText,
  reachabilityHint,
  STATUS_LABEL,
} from '../../src/lib/agent'

// Type-only protocol import keeps protocol sources out of this package's coverage report.
const AGENT_KINDS: readonly AgentKind[] = [
  'claude-code',
  'claude-desktop',
  'codex',
  'codex-desktop',
  'cursor',
  'cursor-cli',
  'pi',
  'opencode',
  'trae',
  'trae-cli',
  'other',
]

describe('agentKindLabel', () => {
  it('labels every kind', () => {
    for (const kind of AGENT_KINDS) expect(agentKindLabel(kind).length).toBeGreaterThan(0)
    expect(agentKindLabel('claude-code')).toBe('Claude Code')
    expect(agentKindLabel('cursor')).toBe('Cursor')
  })
})

describe('agentStatus', () => {
  it('derives status with offline first', () => {
    expect(agentStatus({ connection: 'offline', activity: 'busy' })).toBe('offline')
    expect(agentStatus({ connection: 'online', activity: 'busy' })).toBe('busy')
    expect(agentStatus({ connection: 'stale', activity: 'awaiting_input' })).toBe('awaiting')
    expect(agentStatus({ connection: 'online', activity: 'idle' })).toBe('idle')
    expect(agentStatus({ connection: 'online', activity: 'unknown' })).toBe('idle')
  })
  it('has the §3 labels', () => {
    expect(STATUS_LABEL).toEqual({ idle: '有空', busy: '正在忙', offline: '离线', awaiting: '等你确认' })
  })
})

describe('reachabilityHint (§6)', () => {
  it('says nothing for push agents', () => {
    expect(
      reachabilityHint({ agent: { kind: 'claude-code' }, inject: 'push', accepting: true }),
    ).toBeUndefined()
  })
  it('explains the boundary window with the tool name', () => {
    expect(reachabilityHint({ agent: { kind: 'cursor' }, inject: 'boundary', accepting: true })).toBe(
      'Cursor 一轮结束后 60 分钟内能被问到，超过要你在对话里说句话唤醒它',
    )
  })
  it('explains poll agents, with the Codex hooks case', () => {
    expect(reachabilityHint({ agent: { kind: 'claude-desktop' }, inject: 'poll', accepting: true })).toBe(
      'Claude Desktop 不能自己醒来，你下次在这个对话里说话时它才会看到问题',
    )
    expect(reachabilityHint({ agent: { kind: 'codex' }, inject: 'poll', accepting: true })).toBe(
      '还没在 /hooks 里信任 peers，问题只能等你下次说话',
    )
  })
  it('says paused when not accepting', () => {
    expect(reachabilityHint({ agent: { kind: 'codex' }, inject: 'push', accepting: false })).toBe(
      '已暂停接受提问',
    )
  })
})

describe('state copy (§5)', () => {
  it('builds the outdated plugin and boundary reminder texts', () => {
    expect(outdatedPluginText('0.3.2', '0.4.0')).toContain('Peers 插件是 0.3.2，Core 要 0.4.0 以上')
    expect(boundaryReminderText('cursor', 1)).toContain('它有 1 个问题等着答')
    expect(boundaryReminderText('cursor', 1)).toContain('在 Cursor 的这个对话里')
  })
})
