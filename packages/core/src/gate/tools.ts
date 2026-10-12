/**
 * Tool-name normalization across surfaces. Hooks report tools under different names: Claude Code
 * uses `Read`, `Bash`, `mcp__plugin_peers_peers__peers_reply`; Codex uses `Bash` in hooks but
 * `shell` / `exec_command` / `apply_patch` internally and `mcp__peers__peers_reply`; Cursor uses
 * `Shell` and `read_file`. Everything maps to one canonical name and a class.
 */

/** The bridge's MCP tools (ARCHITECTURE §3.1). */
export const PEERS_TOOLS = [
  'peers_join',
  'peers_create',
  'peers_invite',
  'peers_knock',
  'peers_dashboard',
  'peers_who',
  'peers_ask',
  'peers_send',
  'peers_inbox',
  'peers_status',
  'peers_wait',
  'peers_leave',
  'peers_reply',
  'peers_progress',
  'peers_rename',
] as const
export type PeersTool = (typeof PEERS_TOOLS)[number]

const PEERS_TOOL_SET: ReadonlySet<string> = new Set(PEERS_TOOLS)

export type ToolClass =
  | { readonly kind: 'peers'; readonly name: PeersTool }
  | { readonly kind: 'read'; readonly name: string }
  | { readonly kind: 'shell'; readonly name: 'Bash' }
  | { readonly kind: 'write'; readonly name: string }
  | { readonly kind: 'mcp'; readonly name: string; readonly server: string }
  | { readonly kind: 'other'; readonly name: string }

/** Lower-cased surface names → canonical read-only tool names. */
const READ_ALIASES: Readonly<Record<string, string>> = {
  read: 'Read',
  read_file: 'Read',
  view: 'Read',
  grep: 'Grep',
  grep_files: 'Grep',
  search: 'Grep',
  glob: 'Glob',
  glob_files: 'Glob',
  file_search: 'Glob',
  ls: 'LS',
  list_dir: 'LS',
  list_directory: 'LS',
}

const SHELL_ALIASES: ReadonlySet<string> = new Set([
  'bash',
  'shell',
  'local_shell',
  'shell_command',
  'exec_command',
  'unified_exec',
  'container.exec',
  'run_terminal_cmd',
  'run_shell_command',
])

const WRITE_ALIASES: Readonly<Record<string, string>> = {
  edit: 'Edit',
  write: 'Write',
  multiedit: 'MultiEdit',
  notebookedit: 'NotebookEdit',
  apply_patch: 'apply_patch',
  edit_file: 'Edit',
  write_file: 'Write',
  search_replace: 'Edit',
  delete_file: 'Write',
}

/** `peers` as a whole token of the server name: `peers`, `plugin_peers_peers`, `agent-peers-desktop`. */
const PEERS_SERVER = /(^|[_\-.])peers($|[_\-.])/

/** Splits `mcp__<server>__<tool>`, `<server>.<tool>` or `<server>/<tool>`. */
function splitMcp(name: string): { server: string; tool: string } | undefined {
  if (name.startsWith('mcp__')) {
    const rest = name.slice(5)
    const cut = rest.lastIndexOf('__')
    if (cut <= 0 || cut + 2 >= rest.length) return undefined
    return { server: rest.slice(0, cut), tool: rest.slice(cut + 2) }
  }
  const match = /^([A-Za-z0-9_-]+)[./]([A-Za-z0-9_-]+)$/.exec(name)
  return match?.[1] && match[2] ? { server: match[1], tool: match[2] } : undefined
}

function peersToolName(tool: string): PeersTool | undefined {
  if (PEERS_TOOL_SET.has(tool)) return tool as PeersTool
  const prefixed = `peers_${tool}`
  return PEERS_TOOL_SET.has(prefixed) ? (prefixed as PeersTool) : undefined
}

function classifyMcp(name: string): ToolClass | undefined {
  const parts = splitMcp(name)
  if (!parts) return undefined
  const peers = PEERS_SERVER.test(parts.server.toLowerCase()) ? peersToolName(parts.tool) : undefined
  if (peers) return { kind: 'peers', name: peers }
  return { kind: 'mcp', name, server: parts.server }
}

/** Classifies a tool name reported by any supported surface. */
export function classifyTool(rawName: string): ToolClass {
  const name = rawName.trim()
  if (PEERS_TOOL_SET.has(name)) return { kind: 'peers', name: name as PeersTool }
  const lower = name.toLowerCase()
  const read = READ_ALIASES[lower]
  if (read) return { kind: 'read', name: read }
  if (SHELL_ALIASES.has(lower)) return { kind: 'shell', name: 'Bash' }
  const write = WRITE_ALIASES[lower]
  if (write) return { kind: 'write', name: write }
  return classifyMcp(name) ?? { kind: 'other', name }
}

/** Canonical name used in allowlists (`Read`, `Bash`, `peers_reply`, `mcp__x__y`, …). */
export const canonicalToolName = (rawName: string): string => classifyTool(rawName).name
