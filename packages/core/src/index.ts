export const PACKAGE_NAME = '@agent-peers/core'

/** Wire types and helpers live in @agent-peers/protocol; re-exported so bridge code can use one import. */
export * from '@agent-peers/protocol'
/** @deprecated aliases kept for code written against the old core wire layer. */
export { isPeersError as isHubError, PeersError as HubError } from '@agent-peers/protocol'
export { HubClient } from './client/hub-client'
export type { WebSocketFactory, WebSocketLike } from './client/socket'
export { defaultWebSocketFactory } from './client/socket'
export type {
  ClientState,
  HubClientOptions,
  LifecycleEvent,
  Requester,
  RequestOptions,
  ResyncContext,
  ResyncHook,
} from './client/types'
export { assertTransportAllowed, isPrivateHost, toWebSocketUrl } from './client/url'
// ---- local home and config files ------------------------------------------------------------------
export type { AutojoinQuery } from './config/autojoin'
export {
  autojoinKey,
  defaultAutojoinScope,
  isInsideGitRepo,
  matchAutojoin,
  matchesAutojoin,
  removeAutojoin,
  upsertAutojoin,
} from './config/autojoin'
export { ensurePrivateDir, readJsonFile, writeJsonFile, writePrivateFileAtomic } from './config/fs'
export type { LocalHomeOptions } from './config/local-home'
export { LocalHome } from './config/local-home'
export type { EnvLike, PeersPaths } from './config/paths'
export {
  DIR_MODE,
  expandHome,
  FILE_MODE,
  HOME_ENV,
  infoPathFor,
  peersPaths,
  pidFromRunFile,
  resolvePeersHome,
  socketPathFor,
} from './config/paths'
export { listRunPids, removeRunFiles } from './config/run-dir'
export type {
  AutojoinEntry,
  AutojoinScope,
  Credential,
  Credentials,
  InjectionConfig,
  LocalConfig,
  LocalConfigInput,
  PeerTurnConfig,
  ReplyFallback,
} from './config/schemas'
export {
  AutojoinEntrySchema,
  AutojoinFileSchema,
  AutojoinScopeSchema,
  CredentialSchema,
  CredentialsSchema,
  DEFAULT_DENY_GLOBS,
  DEFAULT_INLINE_WAIT_MS,
  DEFAULT_MAX_REPLAY_AGE_MS,
  DEFAULT_PEER_TURN_COMMANDS,
  DEFAULT_PEER_TURN_TOOLS,
  DEFAULT_PEER_TURNS_PER_HOUR,
  defaultLocalConfig,
  hubOrigin,
  LocalConfigSchema,
  ReplyFallbackSchema,
} from './config/schemas'
// ---- control socket ----------------------------------------------------------------------------
export type { BridgeTarget, BroadcastResult, CallOptions } from './control/client'
export { broadcastToBridges, callBridge, callControl, DEFAULT_CALL_TIMEOUT_MS } from './control/client'
export { DEFAULT_REQUEST_TIMEOUT_MS, Dispatcher } from './control/dispatch'
export type {
  ControlContext,
  ControlHandler,
  ControlOp,
  Injected,
  ParamsInputOf as ControlParamsInput,
  ParamsOf as ControlParams,
  ResultOf as ControlResult,
} from './control/ops'
export {
  CONTROL_OPS,
  MAX_CONTROL_LINE_BYTES,
  MAX_WAIT_MS,
  OP_SCHEMAS as CONTROL_OP_SCHEMAS,
} from './control/ops'
export type { ProcessEntry, ProcessTree } from './control/process-tree'
export {
  agentAncestor,
  ancestorChain,
  isSharedAncestor,
  isShim,
  pidIsAlive,
  psProcessTree,
} from './control/process-tree'
export type { BridgeInfo, BridgeInfoFile, DiscoverOptions } from './control/registry'
export {
  bridgeAgent,
  bridgeAncestors,
  discoverBridges,
  listBridges,
  readBridgeInfo,
  writeBridgeInfo,
} from './control/registry'
export type { ControlServerOptions } from './control/server'
export { ControlServer } from './control/server'
// ---- peer-turn gate ----------------------------------------------------------------------------
export type { ExposureRequest, SearchFilters } from './gate/exposure'
export { exposureProblem, splitGlobList } from './gate/exposure'
export { cachedListFiles, fsExists, fsRealpath, MAX_LISTED_FILES } from './gate/fs-probes'
export type { ListFiles, PathContext, PathVerdict } from './gate/paths'
export { CASE_INSENSITIVE_FS, checkPath } from './gate/paths'
export type {
  GateDecision,
  GateInput,
  PeerTurnView,
  PermissionDecision,
  PermissionInput,
} from './gate/policy'
export { evaluateGate, evaluatePermission, patchPaths } from './gate/policy'
export { checkShellCommand } from './gate/shell-check'
export { parseShell } from './gate/shell-parse'
export type { PeersTool, ToolClass } from './gate/tools'
export { canonicalToolName, classifyTool, PEERS_TOOLS } from './gate/tools'
// ---- injection queue ---------------------------------------------------------------------------
export {
  BUDGET_WINDOW_MS,
  budgetResetsAt,
  decideReplyFallback,
  NO_REPLY_TEXT,
  replyReminder,
  withinBudget,
} from './inject/policy'
export type { InjectQueueOptions } from './inject/queue'
export { DEFAULT_LEASE_MS, InjectQueue } from './inject/queue'
export * as injectState from './inject/state'
export type {
  FallbackReply,
  HandOut,
  InjectChannel,
  InjectMessage,
  ItemState,
  PeerTurn,
  QueueItem,
  QueueState,
  TurnEndOutcome,
} from './inject/types'
export { emptyQueueState } from './inject/types'
export type { InboxJournalOptions, OpenAskQuery, RoomAck } from './journal/inbox-journal'
export { InboxJournal, JournalError, SessionJournal } from './journal/inbox-journal'
export type { AskStatus, Injection, InjectionChannel, JournalEntry, JournalMessage } from './journal/records'
export type { AskInput, ChatInput, ProgressInput, ReplyInput } from './session/messages'
export type { JoinTarget, SessionHandleOptions } from './session/session-handle'
export { SessionHandle } from './session/session-handle'
export type { KnockView, SessionRoom, SessionStatus, SessionView } from './session/view'
export type { Backoff, BackoffOptions, RandomSource } from './util/backoff'
export { backoffDelay, createBackoff, DEFAULT_BACKOFF, resolveBackoff } from './util/backoff'
export type { Clock, TimerHandle } from './util/clock'
export { systemClock } from './util/clock'
export type { Listener, Unsubscribe } from './util/emitter'
