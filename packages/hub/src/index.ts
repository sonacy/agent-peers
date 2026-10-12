/** @agent-peers/hub: Bun.serve + bun:sqlite hub core (PROTOCOL v0.3). */
export const PACKAGE_NAME = '@agent-peers/hub'

export * from './auth/tokens'
export * from './bootstrap'
export type { Clock, TimerHandle } from './clock'
export { systemClock } from './clock'
export * from './config'
export type { HttpLayer } from './http/index'
export {
  createHttpMounts,
  DEFAULT_RATE_LIMITS,
  renderInstallScript,
  renderReleaseInstallScript,
  resolveHttpOptions,
} from './http/index'
export type { AssetBody, AssetMap, HttpOptions, RateLimits, StaticSource } from './http/types'
export type {
  AdminServer,
  CreateHubOptions,
  HttpMounts,
  Hub,
  HubContext,
  PublicServer,
  StartInfo,
} from './hub'
export { createHub } from './hub'
export type { Actor } from './services/access'
export { ADMIN } from './services/access'
export type { LoginLink, WebSession } from './services/auth'
export type { StoredCard } from './services/cards'
export type { Effects, LinkPort, Runtime, ServiceDeps, SessionLink } from './services/context'
export { createDeps, createLinkPort } from './services/context'
export type { EventBus, HubEvent, HubEventListener } from './services/events'
export { createEventBus } from './services/events'
export type { Services } from './services/index'
export { createServices } from './services/index'
export type { RenderedInvite } from './services/invites'
export type { IssuedMember, RedeemResult } from './services/members'
export type { AsksPage, MyRoom, RoomDetail } from './services/queries'
export type { RateDecision, RateLimiter } from './services/rate-limit'
export { createRateLimiter } from './services/rate-limit'
export type { CreatedRoom, CreateRoomInput } from './services/rooms'
export { databasePath, openDatabase } from './storage/db'
export type { Repos } from './storage/repos'
export { createRepos } from './storage/repos'
export type { SocketData } from './ws/connection'
export { Registry } from './ws/registry'
