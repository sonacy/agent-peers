import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { join } from 'node:path'
import { eventually, startWorld, type World } from '../helpers/world'
import { claudeSetup, fixture, parseOut, readLog } from './helpers'

let world: World

beforeEach(async () => {
  world = await startWorld()
})
afterEach(async () => {
  await world.stop()
})

const session = (key = 'cc-1') => ({ session_id: key })

describe('claude-code hooks against a real bridge', () => {
  it('SessionStart registers the session and returns its context', async () => {
    const { hook, cc } = await claudeSetup(world)
    const out = await hook('session-start', await fixture('SessionStart', session()))
    expect(out.exitCode).toBe(0)
    const specific = parseOut(out).hookSpecificOutput as Record<string, unknown>
    expect(specific.hookEventName).toBe('SessionStart')
    expect(String(specific.additionalContext)).toContain('@work in room "team"')
    expect(cc.bridge.runtime?.registry.get('cc-1')?.tier).toBe('push')
    // The fixture's `model` reaches the card (live regression: it used to be dropped).
    await eventually(() =>
      cc.bridge.runtime?.registry.get('cc-1')?.handle.view.card.model === 'claude-opus-5' ? true : undefined,
    )
  })

  it('SessionStart after /clear supersedes the conversation this process ran before', async () => {
    const { hook, cc, alice, roomId } = await claudeSetup(world)
    // A second session on the bridge: the bridge alone could not tell which one /clear replaced.
    await hook('notification', await fixture('Notification', session('cc-x')))
    await hook('SessionStart', await fixture('SessionStart', session('cc-1')))
    const out = await hook('SessionStart', await fixture('SessionStart.clear', session('cc-2')))
    expect(String(JSON.stringify(parseOut(out)))).toContain('@work')
    const keys = cc.bridge.runtime?.registry.keys() ?? []
    expect(keys).toContain('cc-2')
    expect(keys).not.toContain('cc-1')
    const { members } = await alice.session.peers(roomId)
    const work = members.find((m) => m.handle === 'work')
    expect(work?.card.session_id).toBe(cc.bridge.runtime?.registry.get('cc-2')?.sessionId)
  })

  it('UserPromptSubmit marks busy and injects pending envelopes as additionalContext', async () => {
    const { hook, cc, alice, roomId } = await claudeSetup(world)
    const asked = await alice.session.ask({ room_id: roomId, to: 'work', text: 'which port?' })
    await eventually(() => (cc.bridge.runtime?.registry.get('cc-1')?.queue.pendingCount() ? true : undefined))
    const out = await hook('user-prompt-submit', await fixture('UserPromptSubmit', session()))
    const specific = parseOut(out).hookSpecificOutput as Record<string, unknown>
    expect(specific.hookEventName).toBe('UserPromptSubmit')
    expect(String(specific.additionalContext)).toContain(`ask_id ${asked.id}`)
    expect(cc.bridge.runtime?.registry.get('cc-1')?.activity).toBe('busy')
    expect(parseOut(await hook('UserPromptSubmit', await fixture('UserPromptSubmit', session())))).toEqual({})
  })

  it('Stop confirms the turn, nudges once with decision:block, then fails the unanswered ask', async () => {
    const { hook, cc, alice, roomId } = await claudeSetup(world)
    const asked = await alice.session.ask({ room_id: roomId, to: 'work', text: 'which db?' })
    await eventually(() => (cc.bridge.runtime?.registry.get('cc-1')?.queue.pendingCount() ? true : undefined))
    await hook('UserPromptSubmit', await fixture('UserPromptSubmit', session()))
    const stop = await fixture('Stop', { ...session(), last_assistant_message: 'postgres 16' })
    const nudge = parseOut(await hook('stop', stop))
    expect(nudge.decision).toBe('block')
    expect(String(nudge.reason)).toContain(asked.id)
    expect(parseOut(await hook('stop', stop))).toEqual({})
    // The turn was the user's (take), so PROTOCOL §7.3 sends "no reply" rather than the last message.
    const reply = await alice.notes.waitFor('msg.new', (n) => n.message.kind === 'reply')
    expect(reply.message.text).toBe('no reply')
    expect(cc.bridge.runtime?.registry.get('cc-1')?.activity).toBe('idle')
  })

  it('PreToolUse denies off-allowlist tools during a peer turn; PermissionRequest pre-approves the reply', async () => {
    const { hook, cc, alice, roomId } = await claudeSetup(world)
    const pre = await fixture('PreToolUse', session())
    expect(parseOut(await hook('pre-tool-use', pre))).toEqual({})
    const asked = await alice.session.ask({ room_id: roomId, to: 'work', text: 'read the readme' })
    await eventually(() => (cc.bridge.runtime?.registry.get('cc-1')?.queue.pendingCount() ? true : undefined))
    await hook('UserPromptSubmit', await fixture('UserPromptSubmit', session()))
    const denied = parseOut(await hook('PreToolUse', pre)).hookSpecificOutput as Record<string, unknown>
    expect(denied.permissionDecision).toBe('deny')
    expect(String(denied.permissionDecisionReason).length).toBeGreaterThan(0)
    const allow = await hook(
      'permission-request',
      await fixture('PermissionRequest', { ...session(), tool_input: { ask_id: asked.id, text: 'hi' } }),
    )
    expect(parseOut(allow)).toEqual({
      hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } },
    })
    const other = await fixture('PermissionRequest', { ...session(), tool_name: 'Bash', tool_input: {} })
    expect(parseOut(await hook('PermissionRequest', other))).toEqual({})
    const noTool = JSON.stringify({ session_id: 'cc-1', hook_event_name: 'PreToolUse' })
    expect(parseOut(await hook('PreToolUse', noTool))).toEqual({})
    expect(parseOut(await hook('PermissionRequest', noTool))).toEqual({})
  })

  it('Notification, StopFailure and SessionEnd report activity and end the session', async () => {
    const { hook, cc } = await claudeSetup(world)
    await hook('notification', await fixture('Notification', session()))
    expect(cc.bridge.runtime?.registry.get('cc-1')?.activity).toBe('awaiting_input')
    await hook(
      'notification',
      await fixture('Notification', { ...session(), notification_type: 'idle_prompt' }),
    )
    expect(cc.bridge.runtime?.registry.get('cc-1')?.activity).toBe('idle')
    await hook('UserPromptSubmit', await fixture('UserPromptSubmit', session()))
    expect(parseOut(await hook('stop-failure', await fixture('StopFailure', session())))).toEqual({})
    expect(cc.bridge.runtime?.registry.get('cc-1')?.activity).toBe('idle')
    expect(parseOut(await hook('session-end', await fixture('SessionEnd', session())))).toEqual({})
    expect(cc.bridge.runtime?.registry.keys()).not.toContain('cc-1')
  })

  it('the waiter wakes the session with exit 2 and the envelope on stderr', async () => {
    const { hook, cc, alice, roomId } = await claudeSetup(world)
    const waiting = hook('wait', await fixture('Stop', session()))
    await Bun.sleep(100)
    const asked = await alice.session.ask({ room_id: roomId, to: 'work', text: 'are you there?' })
    const woke = await waiting
    expect(woke.exitCode).toBe(2)
    expect(woke.stdout).toBe('')
    expect(woke.stderr).toContain(`ask_id ${asked.id}`)
    expect(cc.bridge.runtime?.registry.get('cc-1')?.activity).toBe('busy')
    // The Stop hook confirms the woken turn's envelope and nudges for the missing reply, then the
    // final message of this wake turn becomes the reply (PROTOCOL §7.3 step 2).
    const stop = await fixture('Stop', { ...session(), last_assistant_message: 'yes, here' })
    expect(parseOut(await hook('Stop', stop)).decision).toBe('block')
    expect(parseOut(await hook('Stop', stop))).toEqual({})
    const reply = await alice.notes.waitFor('msg.new', (n) => n.message.kind === 'reply')
    expect(reply.message.text).toBe('yes, here')
    expect(reply.message.meta?.auto).toBe(true)
  })

  it('a SessionStart waiter registers first; a newer waiter makes the older one exit 0', async () => {
    const { hook, cc } = await claudeSetup(world)
    const started = Date.now()
    const first = hook('SessionStart', await fixture('SessionStart', session('cc-5')), { wait: true })
    await eventually(() => (cc.bridge.runtime?.registry.get('cc-5') ? true : undefined))
    await Bun.sleep(100)
    const second = hook('wait', await fixture('Stop', session('cc-5')), { waiter: { budgetMs: 600 } })
    const superseded = await first
    expect(superseded.exitCode).toBe(0)
    expect(parseOut(superseded)).toEqual({})
    expect(Date.now() - started).toBeLessThan(2500)
    expect((await second).exitCode).toBe(0)
  })

  it('the waiter re-arms until its budget is spent', async () => {
    const { hook } = await claudeSetup(world)
    const started = Date.now()
    const out = await hook('wait', await fixture('Stop', session()), {
      waiter: { budgetMs: 400, earlySlackMs: 50 },
    })
    expect(out.exitCode).toBe(0)
    expect(Date.now() - started).toBeGreaterThanOrEqual(350)
  })
})

describe('claude-code hooks without a bridge', () => {
  it('print {} with exit 0 and log a warning when the bridge is unreachable', async () => {
    const { hook, logPath, cc } = await claudeSetup(world)
    await cc.close()
    const out = await hook('UserPromptSubmit', await fixture('UserPromptSubmit', session()))
    expect(out).toEqual({ exitCode: 0, stdout: '{}\n', stderr: '' })
    expect(await readLog(logPath)).toContain('hook UserPromptSubmit (cc-1): not_connected')
    const waited = await hook('wait', await fixture('SessionStart', session()), {
      waiter: { reconnectWindowMs: 100, retryMs: 10 },
    })
    expect(waited.exitCode).toBe(0)
    expect(await readLog(logPath)).toContain('waiter: bridge unreachable or failing, giving up')
  })

  it('ignores bad input, unknown events and Cursor hosts', async () => {
    const { hook, logPath, deps } = await claudeSetup(world)
    expect(parseOut(await hook('UserPromptSubmit', ''))).toEqual({})
    expect(parseOut(await hook('UserPromptSubmit', 'not json'))).toEqual({})
    expect(parseOut(await hook('UserPromptSubmit', '{"cwd":"/x"}'))).toEqual({})
    const unknown = await fixture('Stop', { ...session(), hook_event_name: 'Teleport' })
    expect(parseOut(await hook('teleport', unknown))).toEqual({})
    const cursor = await fixture('PreToolUse', { ...session(), cursor_version: '3.2' })
    expect(parseOut(await hook('PreToolUse', cursor))).toEqual({})
    const { runClaudeHook } = await import('../../src/injectors/claude-code/run')
    const viaEnv = await runClaudeHook(
      { event: 'Stop', stdin: await fixture('Stop', session()), env: { CURSOR_VERSION: '3.2' } },
      deps,
    )
    expect(viaEnv.stdout).toBe('{}\n')
    const log = await readLog(logPath)
    expect(log).toContain('empty hook input')
    expect(log).toContain('not JSON')
    expect(log).toContain('session_id')
    expect(log).toContain('unknown Claude Code hook event')
    expect(join(logPath)).toContain('logs')
  })
})
