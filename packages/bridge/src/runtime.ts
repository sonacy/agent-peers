/** What tools and the control handler share once the surface is verified. */
import type { Clock, EnvLike, LocalConfig, LocalHome } from '@agent-peers/core'
import type { HubConnection } from './hub/connection'
import type { FetchLike } from './hub/invite'
import type { Injector } from './inject/injector'
import type { SessionRegistry } from './session/registry'
import type { SurfaceDescriptor } from './surface/surfaces'

/** ONBOARDING §4: no hook within 30 s of MCP init means hooks are not running or not trusted. */
export const HOOK_GRACE_MS = 30_000

export interface Runtime {
  readonly descriptor: SurfaceDescriptor
  readonly home: LocalHome
  readonly registry: SessionRegistry
  readonly connection: HubConnection
  readonly injector: Injector
  readonly clock: Clock
  readonly env: EnvLike
  readonly userHome: string
  readonly host: string
  /** Unix ms of MCP initialize. */
  readonly startedAt: number
  readonly fetch: FetchLike
  config(): Promise<LocalConfig>
  log(line: string): void
  /** Opens a URL in the user's browser, best effort. */
  openUrl(url: string): Promise<boolean>
  /** Records that a lifecycle hook reached the bridge. */
  noteHook(): void
  /** The surface has hooks, and none arrived within the grace period. */
  hooksMissing(): boolean
}
