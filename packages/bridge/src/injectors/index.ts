/**
 * Per-surface injectors (ARCHITECTURE §6.1): how a bridge reaches an idle session.
 * - Claude Code: pull. The asyncRewake waiter and the prompt/stop hooks (`agent-peers hook`) call
 *   the bridge over the control socket; the bridge-side injector only advertises the tier.
 * - Codex CLI / Codex desktop: `codex queue` when the thread is idle, hooks otherwise.
 * - Claude Desktop: poll. Envelopes stay in the inbox for `peers_inbox` / `peers_wait`.
 */
import type { EnvLike } from '@agent-peers/core'
import { type Injector, pollInjector } from '../inject/injector'
import type { BridgeSurface } from '../surface/surfaces'
import { claudeCodeInjector } from './claude-code/injector'
import { CodexQueueInjector, type CodexQueueOptions } from './codex/queue-injector'

export type { ClaudeHookEvent, ClaudeHookInput } from './claude-code/input'
export { CLAUDE_HOOK_EVENTS, normalizeEvent, parseHookInput } from './claude-code/input'
export type { HookLogger } from './claude-code/log'
export { fileLogger, hookLogPath } from './claude-code/log'
export type { HookJson, HookResult } from './claude-code/output'
export type { ClaudeHookDeps, ClaudeHookRequest } from './claude-code/run'
export {
  DEFAULT_WAIT_TIMEOUT_S,
  defaultClaudeHookDeps,
  runClaudeHook,
  WAIT_EXIT_MARGIN_MS,
} from './claude-code/run'
export { HookState } from './claude-code/state'
export type { BridgeCall, BridgeCaller } from './claude-code/transport'
export { discoveryCaller } from './claude-code/transport'
export type { WaiterOptions } from './claude-code/waiter'
export type { BinaryPreference, CodexBinary } from './codex/binary'
export { CODEX_BUNDLE_PATHS, MIN_QUEUE_VERSION, resolveCodexBinary } from './codex/binary'
export type { ProcessResult, ProcessRunner } from './codex/process'
export { bunRunner } from './codex/process'
export type { CodexQueueOptions, ProbeState, QueueDelivery } from './codex/queue-injector'
export { CodexQueueInjector, claudeCodeInjector }

export interface InjectorOptions extends Partial<Omit<CodexQueueOptions, 'env' | 'surface'>> {
  readonly env: EnvLike
}

/** The injector `agent-peers mcp --surface <s>` plugs into the bridge. */
export function injectorFor(surface: BridgeSurface, options: InjectorOptions): Injector {
  switch (surface) {
    case 'claude-code':
      return claudeCodeInjector()
    case 'claude-desktop':
      return pollInjector()
    case 'codex':
    case 'codex-desktop':
      return new CodexQueueInjector({ ...options, surface })
  }
}
