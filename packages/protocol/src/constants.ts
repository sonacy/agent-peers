/** Wire constants, defaults and limits from PROTOCOL v0.3. Times are milliseconds unless noted. */

const SECOND = 1000
const MINUTE = 60 * SECOND
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

/** §11: `agent-peers/<major>.<minor>`. */
export const PROTOCOL_VERSION = 'agent-peers/0.3'
/** Versions this implementation can speak, newest first. */
export const SUPPORTED_PROTOCOLS: readonly string[] = [PROTOCOL_VERSION]
export const PROTOCOL_PREFIX = 'agent-peers/'

/** The fixed npm package the join prompt runs (ONBOARDING §2). */
export const CLI_PACKAGE = '@agent-peers/cli'

// ---- §1 transport ---------------------------------------------------------------------------------
export const WS_PATH = '/v0/ws'
/** §1: frames are at most 256 KiB. */
export const MAX_FRAME_BYTES = 256 * 1024
/** §1: message text is at most 64 KiB (UTF-8 bytes). */
export const MAX_TEXT_BYTES = 64 * 1024
/** Serialized `meta` is capped so any accepted message still fits a notification frame. */
export const MAX_META_BYTES = 8 * 1024
/** Room left in a frame for the JSON-RPC envelope and notification fields around a payload. */
export const FRAME_ENVELOPE_MARGIN_BYTES = 4 * 1024

/**
 * WebSocket close code for a missing, invalid or revoked member token. The hub accepts the upgrade
 * and closes with this code, so a bridge can tell "stop reconnecting" from a network failure.
 */
export const UNAUTHORIZED_CLOSE_CODE = 4401

// ---- §2 names, titles and free text ----------------------------------------------------------------
export const MAX_NAME_LENGTH = 32
/** §2: titles are up to 40 characters in any language. */
export const MAX_TITLE_CHARS = 40
/** §3: every other free-text card field is a single line of at most 80 characters. */
export const MAX_LINE_CHARS = 80
/** §10.2: a knock note is one line of at most 120 characters. */
export const MAX_KNOCK_NOTE_CHARS = 120
/** ONBOARDING §2: room name and inviter in a join prompt are one line of at most 80 characters. */
export const MAX_PROMPT_VALUE_CHARS = 80
/** Upper bound on raw free-text input before it is sanitized, so a huge string is refused early. */
export const MAX_RAW_LINE_CHARS = 4096
/** Upper bound on ids (ULIDs are 26) and local keys. */
export const MAX_ID_LENGTH = 64
export const MAX_LOCAL_KEY_LENGTH = 256
export const MAX_SEARCH_QUERY_CHARS = 100

// ---- §4/§5 connection and presence ------------------------------------------------------------------
export const DEFAULT_HEARTBEAT_MS = 15 * SECOND
export const DEFAULT_GRACE_MS = 90 * SECOND
/** §5.1: no frame for this many heartbeats means stale (hub) or dead (bridge). */
export const DEAD_AFTER_HEARTBEATS = 2
export const RECONNECT_MIN_MS = 1 * SECOND
export const RECONNECT_MAX_MS = 30 * SECOND
/** ±20 % jitter on reconnect delays. */
export const RECONNECT_JITTER = 0.2
/** §5.1: bridges close sessions that can't signal their end after this long without activity. */
export const DEFAULT_IDLE_CLOSE_MS = 12 * HOUR
/** §5.2: `session.update` activity is debounced to 300 ms. */
export const ACTIVITY_DEBOUNCE_MS = 300
/** §5.2: `presence.changed` fan-out is at most once per second per session. */
export const PRESENCE_FANOUT_MS = 1 * SECOND

// ---- §6 messages and asks ---------------------------------------------------------------------------
export const DEFAULT_ASK_TTL_MS = 24 * HOUR
export const MAX_ASK_TTL_MS = 24 * HOUR
export const MAX_OPEN_ASKS_PER_TARGET = 20
export const MAX_OPEN_ASKS_PER_ASKER_TARGET = 3
/** §6.3: replay sends at most the last 50 messages above the cursor. */
export const REPLAY_LIMIT = 50
/** §6.4: `msg.history` limit ≤ 200. */
export const MAX_HISTORY_LIMIT = 200
/** §6.4: the hub dedupes `client_msg_id` for 10 minutes. */
export const DEDUP_WINDOW_MS = 10 * MINUTE

/** §6.4: sends the hub dedupes on `client_msg_id`, so they are safe to retry after a reconnect. */
export const IDEMPOTENT_METHODS: ReadonlySet<string> = new Set(['msg.send', 'msg.reply', 'msg.progress'])

// ---- §7 injection ----------------------------------------------------------------------------------
/** §7.2 / ARCHITECTURE §6.1: default `max_inject_chars` per adapter. */
export const MAX_INJECT_CHARS = {
  'claude-code': 8000,
  codex: 6000,
  cursor: 8000,
  pi: 64 * 1024,
  opencode: 64 * 1024,
} as const
export const DEFAULT_MAX_INJECT_CHARS = 6000
/** §7.2: nonce bytes (rendered as hex) framing untrusted text. */
export const ENVELOPE_NONCE_BYTES = 3

// ---- §8 auth -------------------------------------------------------------------------------------
/** 16 base32 characters = 80 bits. */
export const INVITE_CODE_LENGTH = 16
export const REDEEMS_PER_MINUTE_PER_IP = 10
export const MESSAGES_PER_MINUTE_PER_MEMBER = 30

// ---- §9 HTTP ---------------------------------------------------------------------------------------
export const DEFAULT_PUBLIC_PORT = 7337
export const DEFAULT_ADMIN_PORT = 7338
export const DEFAULT_ADMIN_BIND = '127.0.0.1'
export const DASHBOARD_LOGIN_TTL_MS = 5 * MINUTE
export const MEMBER_COOKIE_TTL_MS = 7 * DAY
export const MESSAGE_RETENTION_MS = 30 * DAY

// ---- §10 knocks ------------------------------------------------------------------------------------
export const MAX_OPEN_KNOCKS_PER_MEMBER_ROOM = 1
export const KNOCK_EXPIRY_MS = 7 * DAY
export const KNOCK_RETRY_AFTER_DECLINE_MS = 24 * HOUR
