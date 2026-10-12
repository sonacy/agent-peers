/**
 * Surface descriptors (ARCHITECTURE §6.1): which agent product a bridge serves, its injection tier,
 * `max_inject_chars`, and the caps that keep long-polls below the client's MCP tool timeout.
 */
import type { AgentKind, InjectTier } from '@agent-peers/protocol'

/** `--surface` values `agent-peers mcp` accepts. `codex` also covers Codex desktop, detected at runtime. */
export const BRIDGE_SURFACES = ['claude-code', 'claude-desktop', 'codex', 'codex-desktop'] as const
export type BridgeSurface = (typeof BRIDGE_SURFACES)[number]

export const isBridgeSurface = (value: unknown): value is BridgeSurface =>
  typeof value === 'string' && (BRIDGE_SURFACES as readonly string[]).includes(value)

/** How the surface's lifecycle hooks reach the bridge. */
export type HookTransport = 'control-socket' | 'mcp-tool' | 'none'

/** Where the calling session's `local_key` comes from (ARCHITECTURE §3.1, §6.1). */
export type SessionSource = 'env' | 'single' | 'turn-metadata'

export interface SurfaceDescriptor {
  readonly surface: BridgeSurface
  readonly agentKind: AgentKind
  /** Tier advertised once the surface's hooks have reached the bridge (PROTOCOL §7.1). */
  readonly hookedTier: InjectTier
  /** Tier advertised before any hook arrived (hooks not installed or not trusted). */
  readonly baseTier: InjectTier
  /** Envelope budget for hook and tool output (PROTOCOL §7.2). */
  readonly maxInjectChars: number
  /** Upper bound of the inline `peers_ask` wait, below the client's tool timeout. */
  readonly inlineWaitCapMs: number
  /** Upper bound of one `peers_wait` long-poll (listen mode). */
  readonly waitCapMs: number
  readonly hooks: HookTransport
  /** A turn-end hook can continue the agent once (PROTOCOL §7.3 step 1). */
  readonly canNudge: boolean
  /** The tool gate runs on this surface, so peer turns are tracked and gated. */
  readonly gated: boolean
  readonly sessionSource: SessionSource
}

const SECOND = 1000
/** Claude Desktop caps user-added local servers at 60 s; Codex's default tool timeout is 60 s too. */
const SAFE_WAIT_MS = 50 * SECOND

const CODEX_BASE = {
  agentKind: 'codex',
  hookedTier: 'boundary',
  baseTier: 'poll',
  maxInjectChars: 6000,
  // The plugin's mcp.json sets tool_timeout_sec = 120; stay well below it.
  inlineWaitCapMs: 100 * SECOND,
  waitCapMs: SAFE_WAIT_MS,
  hooks: 'mcp-tool',
  canNudge: true,
  gated: true,
  sessionSource: 'turn-metadata',
} as const satisfies Omit<SurfaceDescriptor, 'surface'>

export const SURFACE_DESCRIPTORS: Readonly<Record<BridgeSurface, SurfaceDescriptor>> = {
  'claude-code': {
    surface: 'claude-code',
    agentKind: 'claude-code',
    hookedTier: 'push',
    baseTier: 'poll',
    maxInjectChars: 8000,
    inlineWaitCapMs: 110 * SECOND,
    waitCapMs: SAFE_WAIT_MS,
    hooks: 'control-socket',
    canNudge: true,
    gated: true,
    sessionSource: 'env',
  },
  'claude-desktop': {
    surface: 'claude-desktop',
    agentKind: 'claude-desktop',
    hookedTier: 'poll',
    baseTier: 'poll',
    maxInjectChars: 8000,
    inlineWaitCapMs: SAFE_WAIT_MS,
    waitCapMs: SAFE_WAIT_MS,
    hooks: 'none',
    canNudge: false,
    gated: false,
    sessionSource: 'single',
  },
  codex: { surface: 'codex', ...CODEX_BASE },
  'codex-desktop': { surface: 'codex-desktop', ...CODEX_BASE, agentKind: 'codex-desktop' },
}

export const descriptorFor = (surface: BridgeSurface): SurfaceDescriptor => SURFACE_DESCRIPTORS[surface]

/** The family a surface belongs to: both Codex surfaces share one plugin tree. */
export const surfaceFamily = (surface: BridgeSurface): 'claude-code' | 'claude-desktop' | 'codex' =>
  surface === 'codex-desktop' ? 'codex' : surface

/** Claude Desktop is one session per app (ARCHITECTURE §6.1): `claude-desktop@<host>`. */
export const desktopLocalKey = (host: string): string => `claude-desktop@${host}`
