/**
 * Codex config.toml edits (ARCHITECTURE §6.1): pre-approve the reply tools of the peers plugin
 *
 *   [plugins."peers@agent-peers".mcp_servers.peers.tools.peers_reply]
 *   approval_mode = "approve"
 *
 * The block is appended as text so the user's comments and layout survive; the result is re-parsed
 * with smol-toml and, if appending is not valid there (the table already exists in another form),
 * the merged document is re-serialized instead. A value the user set themselves is kept.
 */
import { parse, stringify, type TomlTable, type TomlValue } from 'smol-toml'
import { PLUGIN_ID } from '../assets/materialize'

/** `AUTO_APPROVED_TOOLS` in adapters/tools.ts: the only tools a config may auto-approve. */
export const APPROVED_TOOLS = ['peers_reply', 'peers_progress'] as const
export const MCP_SERVER = 'peers'
export const APPROVAL_MODE = 'approve'
export const APPROVAL_MARKER =
  '# agent-peers: auto-approve the peers reply tools (`agent-peers remove` deletes this block)'

const toolHeader = (tool: string): string =>
  `[plugins."${PLUGIN_ID}".mcp_servers.${MCP_SERVER}.tools.${tool}]`

export function approvalBlock(tools: readonly string[]): string {
  const tables = tools.map((tool) => `${toolHeader(tool)}\napproval_mode = "${APPROVAL_MODE}"\n`)
  return `${APPROVAL_MARKER}\n${tables.join('\n')}`
}

const isTable = (value: unknown): value is TomlTable =>
  typeof value === 'object' && value !== null && !Array.isArray(value) && !(value instanceof Date)

const child = (table: TomlTable | undefined, key: string): TomlTable | undefined => {
  const value = table?.[key]
  return isTable(value) ? value : undefined
}

/** `plugins."peers@agent-peers".mcp_servers.peers.tools` of a parsed config. */
function toolsTable(config: TomlTable): TomlTable | undefined {
  return child(child(child(child(child(config, 'plugins'), PLUGIN_ID), 'mcp_servers'), MCP_SERVER), 'tools')
}

/** approval_mode per reply tool (undefined when unset). */
export function approvalModes(config: TomlTable): Readonly<Record<string, string | undefined>> {
  const tools = toolsTable(config)
  return Object.fromEntries(
    APPROVED_TOOLS.map((tool) => {
      const mode = child(tools, tool)?.approval_mode
      return [tool, typeof mode === 'string' ? mode : undefined]
    }),
  )
}

export function parseConfig(text: string): TomlTable {
  try {
    return parse(text)
  } catch (error) {
    throw new Error(`config.toml is not valid TOML (${String(error)}); fix it, then rerun`)
  }
}

/** A new table with `value` at `path` (every level copied, nothing mutated). */
function setIn(table: TomlTable, path: readonly string[], value: TomlValue): TomlTable {
  const [head, ...rest] = path
  if (head === undefined) return table
  if (rest.length === 0) return { ...table, [head]: value }
  const next = isTable(table[head]) ? (table[head] as TomlTable) : {}
  return { ...table, [head]: setIn(next, rest, value) }
}

/** A new table without `path`; parents left empty by the removal are dropped too. */
function deleteIn(table: TomlTable, path: readonly string[]): TomlTable {
  const [head, ...rest] = path
  if (head === undefined || !(head in table)) return table
  if (rest.length === 0) {
    const { [head]: _removed, ...others } = table
    return others
  }
  const nested = table[head]
  if (!isTable(nested)) return table
  const pruned = deleteIn(nested, rest)
  if (Object.keys(pruned).length > 0) return { ...table, [head]: pruned }
  const { [head]: _empty, ...others } = table
  return others
}

const modePath = (tool: string): readonly string[] => [
  'plugins',
  PLUGIN_ID,
  'mcp_servers',
  MCP_SERVER,
  'tools',
  tool,
  'approval_mode',
]

export interface ConfigEdit {
  readonly text: string
  readonly changed: boolean
  /** Tools whose approval_mode the user set to something else (left alone). */
  readonly kept: readonly string[]
}

const withNewline = (text: string): string => (text === '' || text.endsWith('\n') ? text : `${text}\n`)

/** Adds the approvals that are missing. Pure: text in, text out. */
export function addApprovals(text: string): ConfigEdit {
  const config = parseConfig(text)
  const modes = approvalModes(config)
  const missing = APPROVED_TOOLS.filter((tool) => modes[tool] === undefined)
  const kept = APPROVED_TOOLS.filter((tool) => modes[tool] !== undefined && modes[tool] !== APPROVAL_MODE)
  if (missing.length === 0) return { text, changed: false, kept }
  const prefix = withNewline(text)
  const appended = `${prefix}${prefix === '' ? '' : '\n'}${approvalBlock(missing)}`
  try {
    const check = approvalModes(parse(appended))
    if (missing.every((tool) => check[tool] === APPROVAL_MODE)) return { text: appended, changed: true, kept }
  } catch {
    // the tables exist in another shape: fall back to re-serializing the merged document
  }
  const merged = missing.reduce((acc, tool) => setIn(acc, modePath(tool), APPROVAL_MODE), config)
  return { text: stringify(merged), changed: true, kept }
}

const BLOCK_PATTERN = new RegExp(
  `\\n?${APPROVAL_MARKER.replace(/[.*+?^${}()|[\]\\`]/g, '\\$&')}\\n(?:\\[plugins\\."${PLUGIN_ID}"\\.mcp_servers\\.${MCP_SERVER}\\.tools\\.peers_(?:reply|progress)\\]\\napproval_mode = "${APPROVAL_MODE}"\\n\\n?)+`,
)

/** Removes our approvals (only those still set to "approve"). Pure. */
export function removeApprovals(text: string): ConfigEdit {
  const modes = approvalModes(parseConfig(text))
  const ours = APPROVED_TOOLS.filter((tool) => modes[tool] === APPROVAL_MODE)
  if (ours.length === 0) return { text, changed: false, kept: [] }
  const cut = text.replace(BLOCK_PATTERN, '')
  const after = parseConfig(cut)
  const left = APPROVED_TOOLS.filter((tool) => approvalModes(after)[tool] === APPROVAL_MODE)
  if (left.length === 0) return { text: cut, changed: true, kept: [] }
  const pruned = left.reduce((acc, tool) => deleteIn(acc, modePath(tool)), after)
  return { text: stringify(pruned), changed: true, kept: [] }
}

/** Codex hook trust (`hooks.state."<key>".trusted_hash`) for any of the peers plugin's hooks. */
export function peersHooksTrusted(config: TomlTable): boolean {
  const state = child(child(config, 'hooks'), 'state')
  if (!state) return false
  return Object.entries(state).some(
    ([key, value]) =>
      key.includes(PLUGIN_ID) &&
      isTable(value) &&
      typeof value.trusted_hash === 'string' &&
      value.trusted_hash !== '',
  )
}

/** `[plugins."peers@agent-peers"] enabled = true`. */
export function pluginEnabled(config: TomlTable): boolean | undefined {
  const enabled = child(child(config, 'plugins'), PLUGIN_ID)?.enabled
  return typeof enabled === 'boolean' ? enabled : undefined
}
