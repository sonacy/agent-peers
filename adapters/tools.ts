/**
 * Canonical names shared by the adapter trees, the bridge (`agent-peers mcp`) and the hook entrypoint
 * (`agent-peers hook`). ARCHITECTURE §3.1 (commands and tools), §6 (adapters), §8 (peer-turn gate).
 *
 * Dependency-free on purpose: the plugin trees are static files, and the build/validation script and
 * tests import this module from outside any workspace package.
 */

/** Plugin name in Claude Code and Codex (`/peers:ask`, `$peers:ask`). */
export const PLUGIN_NAME = 'peers'
/** Claude Code marketplace name (`peers@agent-peers`). */
export const MARKETPLACE_NAME = 'agent-peers'
/** Key of the stdio MCP server inside each plugin. */
export const MCP_SERVER_NAME = 'peers'
/** Claude Desktop `mcpServers` key. Distinct so the Desktop Code tab can tell it apart (ARCHITECTURE §4). */
export const DESKTOP_SERVER_NAME = 'agent-peers-desktop'
/** Path of the POSIX shim inside a plugin tree. */
export const SHIM_PATH = 'bin/agent-peers'

/** `--surface` values passed to `agent-peers mcp`. Codex desktop shares the `codex` tree and is detected at runtime. */
export const SURFACES = ['claude-code', 'codex', 'claude-desktop'] as const
export type Surface = (typeof SURFACES)[number]

/**
 * Who a tool is for:
 * - `user`: reachable through a command (skill) and by the model.
 * - `agent`: called by the model while answering an ask (no command).
 * - `hook`: hidden; called only by Codex `mcp_tool` hooks. Its description must tell the model never to call it.
 */
export type ToolAudience = 'user' | 'agent' | 'hook'

export interface PeersTool {
  readonly name: string
  readonly audience: ToolAudience
  readonly summary: string
}

/** Every MCP tool the bridge registers. The bridge must register exactly these names. */
export const PEERS_TOOLS: readonly PeersTool[] = [
  {
    name: 'peers_join',
    audience: 'user',
    summary: 'Redeem an invite if needed, join a room, claim a handle.',
  },
  {
    name: 'peers_create',
    audience: 'user',
    summary: 'Create a room on the default hub and return its join prompt.',
  },
  { name: 'peers_invite', audience: 'user', summary: "Owner only: show or rotate a room's join prompt." },
  { name: 'peers_knock', audience: 'user', summary: 'Ask to join a discoverable room without an invite.' },
  {
    name: 'peers_dashboard',
    audience: 'user',
    summary: 'Open the web dashboard with a one-time login link.',
  },
  {
    name: 'peers_who',
    audience: 'user',
    summary: 'List sessions in joined rooms: handle, state, agent, summary.',
  },
  {
    name: 'peers_ask',
    audience: 'user',
    summary: 'Send an ask to @handle[@room] and wait briefly for the reply.',
  },
  {
    name: 'peers_send',
    audience: 'user',
    summary: 'Post a chat message to a room (inbox only, never starts a turn).',
  },
  { name: 'peers_inbox', audience: 'user', summary: 'Show unread messages and open asks.' },
  { name: 'peers_rename', audience: 'user', summary: "Rename this session's title or handle." },
  { name: 'peers_status', audience: 'user', summary: 'Set the session summary and DND.' },
  { name: 'peers_wait', audience: 'user', summary: 'Listen mode: long-poll for the next peer message.' },
  { name: 'peers_leave', audience: 'user', summary: 'Leave a room and release the handle.' },
  { name: 'peers_reply', audience: 'agent', summary: 'Answer an ask this session claimed.' },
  { name: 'peers_progress', audience: 'agent', summary: 'Report progress on an ask this session claimed.' },
  {
    name: 'peers_hook',
    audience: 'hook',
    summary: 'Internal: Codex lifecycle hooks. Never call it yourself.',
  },
]

export const PEERS_TOOL_NAMES: readonly string[] = PEERS_TOOLS.map((tool) => tool.name)
/** The hidden tool Codex `mcp_tool` hooks call (ARCHITECTURE §6.1, Codex desktop "Hooks → bridge"). */
export const HOOK_TOOL_NAME = 'peers_hook'

/** §6.1 / §8: the only tools a PermissionRequest hook (or Codex approval config) may auto-approve. */
export const AUTO_APPROVED_TOOLS: readonly string[] = ['peers_reply', 'peers_progress']
/** §8.4: never auto-approved; the user always sees the hub host. */
export const NEVER_AUTO_APPROVED_TOOLS: readonly string[] = ['peers_join', 'peers_create', 'peers_invite']
/** §8.3: denied during a peer turn (worm and exfiltration chains). */
export const PEER_TURN_DENIED_TOOLS: readonly string[] = [
  'peers_send',
  'peers_ask',
  'peers_join',
  'peers_leave',
  'peers_create',
  'peers_invite',
]

export interface PeersCommand {
  /** Skill directory name: `/peers:<name>` (Claude Code), `$peers:<name>` (Codex). */
  readonly name: string
  readonly tool: string
  readonly argumentHint: string
  readonly description: string
  /** How the free text after the command maps onto the tool's input. */
  readonly argumentGuide: string
  /** Side effects the user must trigger explicitly: no implicit (model) invocation. */
  readonly userOnly: boolean
}

/** The in-agent commands (ARCHITECTURE §3.1). Each maps to exactly one `user` tool. */
export const PEERS_COMMANDS: readonly PeersCommand[] = [
  {
    name: 'join',
    tool: 'peers_join',
    argumentHint: '<invite> [as <handle>]',
    description: 'Join an agent-peers room with an invite link or code, optionally claiming a handle.',
    argumentGuide: 'The first token is the invite (URL or code). "as <handle>" names the handle to claim.',
    userOnly: true,
  },
  {
    name: 'room',
    tool: 'peers_create',
    argumentHint: 'new <name>',
    description: 'Create a new agent-peers room on the default hub and get its join prompt.',
    argumentGuide: 'Expect "new <name>"; <name> is the room name. Show the returned join prompt verbatim.',
    userOnly: true,
  },
  {
    name: 'who',
    tool: 'peers_who',
    argumentHint: '[room]',
    description: 'List the agent sessions in your agent-peers rooms: handles, presence, agent, summary.',
    argumentGuide: 'An optional room name limits the list to that room; otherwise list every joined room.',
    userOnly: false,
  },
  {
    name: 'ask',
    tool: 'peers_ask',
    argumentHint: '@handle[@room] <question> [--write]',
    description: 'Ask another agent session in your agent-peers rooms a question and wait for its reply.',
    argumentGuide:
      'The first token is the target (@handle or @handle@room), the rest is the question. "--write" marks a write ask.',
    userOnly: false,
  },
  {
    name: 'say',
    tool: 'peers_send',
    argumentHint: '<text>',
    description: 'Post a chat message to your agent-peers room without starting a turn anywhere.',
    argumentGuide: 'All of the text is the message body.',
    userOnly: false,
  },
  {
    name: 'inbox',
    tool: 'peers_inbox',
    argumentHint: '',
    description: 'Show unread agent-peers messages and open asks for this session.',
    argumentGuide: 'No arguments.',
    userOnly: false,
  },
  {
    name: 'rename',
    tool: 'peers_rename',
    argumentHint: '[@new-handle | <title>]',
    description: "Rename this session's agent-peers handle (@name) or its card title.",
    argumentGuide: 'A token starting with @ is the new handle; any other text is the new title.',
    userOnly: false,
  },
  {
    name: 'status',
    tool: 'peers_status',
    argumentHint: '<summary> [dnd|open]',
    description: 'Set what this session is working on, and do-not-disturb, on your agent-peers card.',
    argumentGuide: 'A trailing "dnd" or "open" sets do-not-disturb; the rest is the one-line summary.',
    userOnly: false,
  },
  {
    name: 'leave',
    tool: 'peers_leave',
    argumentHint: '[room]',
    description: 'Leave an agent-peers room and release the handle.',
    argumentGuide: 'An optional room name; without it, leave the only joined room or ask which one.',
    userOnly: true,
  },
  {
    name: 'invite',
    tool: 'peers_invite',
    argumentHint: '[room] [--new]',
    description: "Show (room owners only) an agent-peers room's join prompt, or rotate it with --new.",
    argumentGuide:
      'An optional room name; "--new" rotates the invite. Show the returned join prompt verbatim.',
    userOnly: true,
  },
  {
    name: 'knock',
    tool: 'peers_knock',
    argumentHint: '<room> [note]',
    description: 'Ask the owners of a discoverable agent-peers room to let you in.',
    argumentGuide: 'The first token is the room name; the rest is an optional note to the owners.',
    userOnly: true,
  },
  {
    name: 'dashboard',
    tool: 'peers_dashboard',
    argumentHint: '',
    description: 'Open the agent-peers web dashboard, already signed in.',
    argumentGuide: 'No arguments. Give the user the returned link; never paste it anywhere else.',
    userOnly: true,
  },
  {
    name: 'listen',
    tool: 'peers_wait',
    argumentHint: '[minutes]',
    description: 'Listen for agent-peers asks for a while and answer each as it arrives.',
    argumentGuide:
      'An optional number of minutes. After each message, handle it, then call the tool again until time is up.',
    userOnly: false,
  },
]

/** Claude Code scopes plugin MCP tools: `mcp__plugin_<plugin>_<server>__<tool>` (hooks reference). */
export const claudeCodeToolName = (tool: string): string =>
  `mcp__plugin_${PLUGIN_NAME}_${MCP_SERVER_NAME}__${tool}`
/** Codex names MCP tools `mcp__<server>__<tool>`. */
export const codexToolName = (tool: string): string => `mcp__${MCP_SERVER_NAME}__${tool}`

/**
 * `agent-peers hook <event>` values used by the Claude Code plugin. `wait` is the asyncRewake waiter
 * armed on SessionStart, Stop and StopFailure (ARCHITECTURE §5 `wait`, §6.2).
 */
export const CLAUDE_HOOK_COMMANDS = [
  'session-start',
  'wait',
  'user-prompt-submit',
  'stop',
  'stop-failure',
  'notification',
  'permission-request',
  'pre-tool-use',
  'session-end',
] as const
export type ClaudeHookCommand = (typeof CLAUDE_HOOK_COMMANDS)[number]

/** Codex hook events the plugin handles with `mcp_tool` handlers calling {@link HOOK_TOOL_NAME}. */
export const CODEX_HOOK_EVENTS = ['SessionStart', 'UserPromptSubmit', 'Stop', 'PreToolUse'] as const
