/**
 * Codex push (ARCHITECTURE §6.1–§6.2): `<codex> queue --thread <id> --message <envelope>` hands the
 * envelope to the shared app-server, which starts a turn when the thread is idle.
 *
 * One channel per envelope. The bridge's queue hands an envelope out exactly once; this injector
 * accepts it only when the hooks show the thread idle after a completed turn (Stop set `idle`; an
 * interrupted turn never reports Stop, so it stays `busy` and the envelope is held for the next
 * UserPromptSubmit / Stop delivered through `peers_hook`). `thread/queue/delete` is not reachable
 * from the CLI, so an envelope is never queued "just in case": a fallback can't take it back.
 *
 * Tier: `push` only after a hook proved the plugin's hooks are trusted, the CLI passed its gates
 * (binary found, version ≥ 0.157, no CODEX_EXEC_SERVER_URL) and a `codex queue` for the thread
 * succeeded, which confirms the thread is daemon-hosted (not `--no-daemon` / `--profile`). Otherwise
 * the surface default applies (`boundary` once hooked, `poll` before).
 *
 * A `codex queue` that times out may still have queued the message: it counts as delivered (the
 * envelope stays with Codex, never pushed twice) and the thread backs off.
 */
import type { EnvLike } from '@agent-peers/core'
import type { InjectTier } from '@agent-peers/protocol'
import type { Injector, InjectTarget, PushResult } from '../../inject/injector'
import type { BridgeSurface } from '../../surface/surfaces'
import {
  type BinaryPreference,
  type CodexBinary,
  checkQueueVersion,
  MIN_QUEUE_VERSION,
  resolveCodexBinary,
} from './binary'
import { bunRunner, type ProcessRunner } from './process'

export const QUEUE_TIMEOUT_MS = 10_000
/** After a failed `codex queue` the thread is served by the hook fallbacks for this long. */
export const QUEUE_FAILURE_BACKOFF_MS = 5 * 60 * 1000
const MAX_DELIVERY_RECORDS = 256

export interface CodexQueueOptions {
  readonly env: EnvLike
  readonly surface: 'codex' | 'codex-desktop'
  readonly runner?: ProcessRunner
  /** Finds the CLI (default: resolveCodexBinary over the env, config.toml, the bundle and PATH). */
  readonly resolve?: (prefer: BinaryPreference) => Promise<CodexBinary | undefined>
  readonly now?: () => number
  readonly log?: (line: string) => void
  readonly timeoutMs?: number
  readonly failureBackoffMs?: number
  readonly minVersion?: string
}

export type ProbeState =
  | { readonly status: 'pending' }
  | { readonly status: 'ok'; readonly binary: CodexBinary; readonly version: string }
  | { readonly status: 'unavailable'; readonly reason: string }

export interface QueueDelivery {
  readonly injectId: string
  readonly thread: string
  readonly at: number
  readonly channel: 'codex-queue'
}

const preferenceFor = (surface: BridgeSurface): BinaryPreference =>
  surface === 'codex-desktop' ? 'desktop' : 'cli'

export class CodexQueueInjector implements Injector {
  readonly kind = 'codex-queue'
  private probes: ReadonlyMap<BinaryPreference, ProbeState> = new Map()
  private failures: ReadonlyMap<string, number> = new Map()
  private records: readonly QueueDelivery[] = []
  /** Threads a `codex queue` reached at least once: they are daemon-hosted. */
  private confirmed: ReadonlySet<string> = new Set()
  private tierListeners: readonly (() => void)[] = []
  private readonly runner: ProcessRunner
  private readonly now: () => number
  private readonly log: (line: string) => void

  constructor(private readonly options: CodexQueueOptions) {
    this.runner = options.runner ?? bunRunner
    this.now = options.now ?? Date.now
    this.log = options.log ?? (() => undefined)
    void this.probe(preferenceFor(options.surface))
  }

  /** The envelopes this injector queued, oldest first (bounded). */
  get deliveries(): readonly QueueDelivery[] {
    return this.records
  }

  probeState(surface: BridgeSurface = this.options.surface): ProbeState {
    return this.probes.get(preferenceFor(surface)) ?? { status: 'pending' }
  }

  /** Resolves the CLI once per preference; later calls return the cached result. */
  async probe(prefer: BinaryPreference): Promise<ProbeState> {
    const known = this.probes.get(prefer)
    if (known !== undefined && known.status !== 'pending') return known
    if (known === undefined) this.setProbe(prefer, { status: 'pending' })
    const state = await this.detect(prefer).catch(
      (error: unknown): ProbeState => ({ status: 'unavailable', reason: String(error) }),
    )
    this.setProbe(prefer, state)
    if (state.status === 'unavailable') this.log(`codex queue unavailable: ${state.reason}`)
    this.notifyTier()
    return state
  }

  /** The probe usually finishes after the first hooks registered: cards must re-read the tier then. */
  onTierChange(listener: () => void): () => void {
    this.tierListeners = [...this.tierListeners, listener]
    return () => {
      this.tierListeners = this.tierListeners.filter((l) => l !== listener)
    }
  }

  private notifyTier(): void {
    for (const listener of this.tierListeners) listener()
  }

  private setProbe(prefer: BinaryPreference, state: ProbeState): void {
    this.probes = new Map(this.probes).set(prefer, state)
  }

  private async detect(prefer: BinaryPreference): Promise<ProbeState> {
    if (this.options.env.CODEX_EXEC_SERVER_URL?.trim())
      return { status: 'unavailable', reason: 'CODEX_EXEC_SERVER_URL is set (no shared daemon)' }
    const resolve =
      this.options.resolve ??
      ((p: BinaryPreference) => resolveCodexBinary({ env: this.options.env, prefer: p }))
    const binary = await resolve(prefer)
    if (binary === undefined) return { status: 'unavailable', reason: 'codex CLI not found' }
    const check = await checkQueueVersion(
      binary,
      this.runner,
      this.options.env,
      this.options.minVersion ?? MIN_QUEUE_VERSION,
    )
    if (!check.ok || check.version === undefined)
      return { status: 'unavailable', reason: check.reason ?? 'unknown codex version' }
    return { status: 'ok', binary, version: check.version }
  }

  private ready(target: InjectTarget): CodexBinary | undefined {
    const state = this.probeState(target.surface)
    if (state.status === 'ok') return state.binary
    if (!this.probes.has(preferenceFor(target.surface))) void this.probe(preferenceFor(target.surface))
    return undefined
  }

  private backedOff(thread: string): boolean {
    const until = this.failures.get(thread)
    return until !== undefined && this.now() < until
  }

  canPush(target: InjectTarget): boolean {
    if (!target.hooked || target.activity !== 'idle' || this.backedOff(target.localKey)) return false
    return this.ready(target) !== undefined
  }

  async push(envelope: string, target: InjectTarget & { readonly injectId: string }): Promise<PushResult> {
    const binary = this.canPush(target) ? this.ready(target) : undefined
    if (binary === undefined) return 'unsupported'
    const result = await this.runner(
      [binary.path, 'queue', '--thread', target.localKey, '--message', envelope],
      { env: this.options.env, timeoutMs: this.options.timeoutMs ?? QUEUE_TIMEOUT_MS },
    )
    if (result.exitCode === 0) {
      this.record({
        injectId: target.injectId,
        thread: target.localKey,
        at: this.now(),
        channel: 'codex-queue',
      })
      if (!this.confirmed.has(target.localKey)) {
        this.confirmed = new Set(this.confirmed).add(target.localKey)
        this.notifyTier()
      }
      return 'delivered'
    }
    this.backOff(target.localKey)
    if (result.timedOut) {
      // Ambiguous: the message may be in Codex's queue. Never hand it out a second time.
      this.log(`codex queue for thread ${target.localKey} timed out; treating the envelope as queued`)
      return 'delivered'
    }
    const why = `exit ${result.exitCode}: ${result.stderr.trim().slice(0, 300)}`
    this.log(`codex queue for thread ${target.localKey} failed (${why}); holding envelopes for hooks`)
    return 'unsupported'
  }

  private backOff(thread: string): void {
    const backoff = this.options.failureBackoffMs ?? QUEUE_FAILURE_BACKOFF_MS
    this.failures = new Map(this.failures).set(thread, this.now() + backoff)
    this.notifyTier()
  }

  tier(target: InjectTarget): InjectTier | undefined {
    if (!target.hooked || this.backedOff(target.localKey) || !this.confirmed.has(target.localKey))
      return undefined
    return this.probeState(target.surface).status === 'ok' ? 'push' : undefined
  }

  private record(delivery: QueueDelivery): void {
    this.records = [...this.records, delivery].slice(-MAX_DELIVERY_RECORDS)
  }
}
