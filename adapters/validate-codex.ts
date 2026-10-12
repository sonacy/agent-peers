/** Structural checks for `adapters/codex` (Codex CLI and Codex desktop share this tree). */
import { join } from 'node:path'
import {
  CODEX_HOOK_EVENTS,
  HOOK_TOOL_NAME,
  MCP_SERVER_NAME,
  PEERS_COMMANDS,
  PLUGIN_NAME,
  SHIM_PATH,
} from './tools'
import {
  check,
  fileExists,
  type Issues,
  isContainedCommand,
  isNonEmptyString,
  isObject,
  type JsonObject,
  readJsonObject,
  readText,
  sameList,
  sameSet,
} from './validate-common'
import { validateShim, validateSkills } from './validate-shared'

export const CODEX_SHIM_COMMAND = `./${SHIM_PATH}`
/** SessionStart is not turn-scoped in Codex, so only the other events template `${turn_id}`. */
const TURN_SCOPED: readonly string[] = ['UserPromptSubmit', 'Stop', 'PreToolUse']

const validateManifest = (manifest: JsonObject): Issues => [
  ...check(manifest.name === PLUGIN_NAME, `plugin.json: name must be "${PLUGIN_NAME}"`),
  ...check(isNonEmptyString(manifest.version), 'plugin.json: version is required'),
  ...check(isNonEmptyString(manifest.description), 'plugin.json: description is required'),
  ...check(manifest.skills === './skills/', 'plugin.json: skills must be "./skills/"'),
  ...check(manifest.mcpServers === './mcp.json', 'plugin.json: mcpServers must be "./mcp.json"'),
  ...check(
    isObject(manifest.interface) && isNonEmptyString(manifest.interface.displayName),
    'plugin.json: interface.displayName is required',
  ),
]

/** Codex hook input template for an event field: `${field}`, which keeps the field's JSON type. */
export const placeholder = (field: string): string => `\${${field}}`

const templated = (input: JsonObject, field: string, where: string): Issues =>
  check(input[field] === placeholder(field), `${where}: input.${field} must be ${placeholder(field)}`)

const validateHookHandler = (event: string, handler: unknown): Issues => {
  const where = `plugin.json hooks ${event}`
  if (!isObject(handler)) return [`${where}: handler must be an object`]
  const input = isObject(handler.input) ? handler.input : {}
  const turnScoped = TURN_SCOPED.includes(event)
  return [
    ...check(handler.type === 'mcp_tool', `${where}: handler type must be "mcp_tool"`),
    ...check(handler.server === MCP_SERVER_NAME, `${where}: server must be "${MCP_SERVER_NAME}"`),
    ...check(handler.tool === HOOK_TOOL_NAME, `${where}: tool must be "${HOOK_TOOL_NAME}"`),
    ...check(typeof handler.timeout === 'number' && handler.timeout > 0, `${where}: a timeout is required`),
    ...check(input.agent === 'codex', `${where}: input.agent must be "codex"`),
    ...templated(input, 'session_id', where),
    ...templated(input, 'hook_event_name', where),
    ...(turnScoped
      ? templated(input, 'turn_id', where)
      : check(input.turn_id === undefined, `${where}: input.turn_id must be absent (not turn-scoped)`)),
  ]
}

export const validateCodexHooks = (manifest: JsonObject): Issues => {
  const wrapper = isObject(manifest.hooks) ? manifest.hooks : undefined
  const events = wrapper && isObject(wrapper.hooks) ? wrapper.hooks : undefined
  if (!events) return ['plugin.json: inline hooks must be { "hooks": { <event>: [...] } }']
  const perEvent = CODEX_HOOK_EVENTS.flatMap((event) => {
    const groups = Array.isArray(events[event]) ? events[event] : []
    const handlers = groups.flatMap((group: unknown) =>
      isObject(group) && Array.isArray(group.hooks) ? group.hooks : [],
    )
    return [
      ...check(handlers.length === 1, `plugin.json hooks ${event}: exactly one peers_hook handler expected`),
      ...handlers.flatMap((handler: unknown) => validateHookHandler(event, handler)),
    ]
  })
  return [
    ...check(
      sameSet(Object.keys(events), CODEX_HOOK_EVENTS),
      `plugin.json hooks: events must be ${CODEX_HOOK_EVENTS.join(', ')}`,
    ),
    ...perEvent,
  ]
}

const validateMcp = (config: JsonObject): Issues => {
  const servers = isObject(config.mcpServers) ? config.mcpServers : {}
  const server = servers[MCP_SERVER_NAME]
  if (!isObject(server)) return [`mcp.json: mcpServers.${MCP_SERVER_NAME} is required`]
  const command = typeof server.command === 'string' ? server.command : ''
  return [
    ...check(command === CODEX_SHIM_COMMAND, `mcp.json: command must be ${CODEX_SHIM_COMMAND}`),
    ...check(isContainedCommand(command), 'mcp.json: command must be a bare name or a contained ./ path'),
    ...check(
      sameList(server.args, ['mcp', '--surface', 'codex']),
      'mcp.json: args must be mcp --surface codex',
    ),
    ...check(server.cwd === undefined, 'mcp.json: leave cwd unset so the bridge sees the workspace'),
  ]
}

export const validateCodexPlugin = async (dir: string): Promise<Issues> => {
  const [manifest, mcp, readme] = await Promise.all([
    readJsonObject(join(dir, '.codex-plugin/plugin.json'), 'plugin.json'),
    readJsonObject(join(dir, 'mcp.json'), 'mcp.json'),
    readText(join(dir, 'README.md')),
  ])
  const [skills, shim, legacyHooks] = await Promise.all([
    validateSkills(dir, 'codex', PEERS_COMMANDS),
    validateShim(dir),
    fileExists(join(dir, 'hooks/hooks.json')),
  ])
  return [
    ...manifest.issues,
    ...validateManifest(manifest.value),
    ...validateCodexHooks(manifest.value),
    ...check(!legacyHooks, 'hooks/hooks.json: hooks live inline in plugin.json; remove the file'),
    ...mcp.issues,
    ...validateMcp(mcp.value),
    ...check(
      readme?.includes('approval_mode = "approve"') ?? false,
      'README.md: must document peers_reply approval_mode',
    ),
    ...skills,
    ...shim,
  ].map((issue) => `codex: ${issue}`)
}
