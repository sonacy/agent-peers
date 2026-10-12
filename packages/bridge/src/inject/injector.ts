/**
 * Injectors push an envelope into an idle agent session (ARCHITECTURE §6.1 "Primary injection"). The
 * per-surface implementations (Codex `thread/queue/add`, …) live behind this interface; the bridge
 * only decides *when* to push and keeps the envelope's exactly-once bookkeeping (InjectQueue).
 *
 * Pull surfaces need no injector: Claude Code delivers through the asyncRewake `wait` hook and the
 * `take` fallback, Claude Desktop through `peers_inbox` (poll tier).
 */
import type { Activity, InjectTier } from '@agent-peers/protocol'
import type { BridgeSurface } from '../surface/surfaces'

export interface InjectTarget {
  readonly localKey: string
  readonly surface: BridgeSurface
  /** Last activity the hooks reported (`unknown` before any). */
  readonly activity: Activity
  /** The surface's hooks have reached the bridge (registration, prompt, stop…). */
  readonly hooked: boolean
  /**
   * A waiter can wake the idle session (Claude Code asyncRewake): one is polling, or the last one woke
   * the session and the turn's Stop re-arms it. False when waiters stopped coming.
   */
  readonly waiting?: boolean
}

/** `delivered`: the agent will see it (keep the hand-out leased). `unsupported`: hand it back. */
export type PushResult = 'delivered' | 'unsupported'

export interface Injector {
  readonly kind: string
  /** Cheap check before an envelope is claimed and handed out for a push. */
  canPush(target: InjectTarget): boolean
  push(envelope: string, target: InjectTarget & { readonly injectId: string }): Promise<PushResult>
  /** The tier this injector can currently deliver for the session; undefined keeps the surface default. */
  tier?(target: InjectTarget): InjectTier | undefined
  /**
   * Called whenever `tier()` may answer differently (a capability probe finished, a push failed), so
   * cards re-advertise their tier. Returns the unsubscribe function.
   */
  onTierChange?(listener: () => void): () => void
  close?(): Promise<void>
}

/** No push channel: envelopes wait for `wait` / `take` / `peers_inbox`. */
export const pullInjector = (kind = 'pull'): Injector => ({
  kind,
  canPush: () => false,
  push: async () => 'unsupported',
})

/** Claude Desktop (poll tier): the model checks `peers_inbox` each turn (server instructions). */
export const pollInjector = (): Injector => ({
  ...pullInjector('poll'),
  tier: () => 'poll',
})

/** Default injector per surface until the surface-specific injectors are plugged in. */
export function defaultInjector(surface: BridgeSurface): Injector {
  return surface === 'claude-desktop' ? pollInjector() : pullInjector()
}
