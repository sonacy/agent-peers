/**
 * Bridge side of the Claude Code injector. Claude Code is reached by pull: the asyncRewake waiter
 * (`wait`) wakes an idle session and UserPromptSubmit `take` covers the rest, so the bridge never
 * pushes. The tier (PROTOCOL §7.1, the current effective tier) is `push` only while a waiter can wake
 * the session, `boundary` when hooks run but no waiter is armed (it gave up, `claude -p` killed it),
 * and `poll` before any hook reached the bridge (ARCHITECTURE §6.1).
 */
import type { Injector } from '../../inject/injector'

export function claudeCodeInjector(): Injector {
  return {
    kind: 'claude-code-rewake',
    canPush: () => false,
    push: async () => 'unsupported',
    tier: (target) => (!target.hooked ? 'poll' : target.waiting === true ? 'push' : 'boundary'),
  }
}
