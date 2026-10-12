/** Structural checks for `adapters/claude-code` beyond what `claude plugin validate` covers. */
import { join } from 'node:path'
import {
  AUTO_APPROVED_TOOLS,
  CLAUDE_HOOK_COMMANDS,
  claudeCodeToolName,
  MCP_SERVER_NAME,
  PEERS_COMMANDS,
  PEERS_TOOLS,
  PLUGIN_NAME,
  SHIM_PATH,
} from './tools'
import {
  check,
  type Issues,
  isNonEmptyString,
  isObject,
  type JsonObject,
  readJsonObject,
  sameList,
  sameSet,
} from './validate-common'
import { validateShim, validateSkills } from './validate-shared'

export const CLAUDE_SHIM_COMMAND = `\${CLAUDE_PLUGIN_ROOT}/${SHIM_PATH}`
/** The asyncRewake waiter must outlive idle periods; the timeout is enforced for asyncRewake hooks. */
export const MIN_WAITER_TIMEOUT_SEC = 3600

/** Which `agent-peers hook <cmd>` each event runs (besides the waiter). */
export const CLAUDE_EVENT_COMMANDS: { readonly [event: string]: readonly string[] } = {
  SessionStart: ['session-start', 'wait'],
  UserPromptSubmit: ['user-prompt-submit'],
  Stop: ['stop', 'wait'],
  StopFailure: ['stop-failure', 'wait'],
  Notification: ['notification'],
  PermissionRequest: ['permission-request'],
  PreToolUse: ['pre-tool-use'],
  SessionEnd: ['session-end'],
}

const validateManifest = (manifest: JsonObject): Issues => [
  ...check(manifest.name === PLUGIN_NAME, `plugin.json: name must be "${PLUGIN_NAME}"`),
  ...check(isNonEmptyString(manifest.version), 'plugin.json: version is required'),
  ...check(isNonEmptyString(manifest.description), 'plugin.json: description is required'),
  ...check(
    isObject(manifest.author) && isNonEmptyString(manifest.author.name),
    'plugin.json: author.name is required',
  ),
]

const validateMcp = (config: JsonObject): Issues => {
  const servers = isObject(config.mcpServers) ? config.mcpServers : {}
  const server = servers[MCP_SERVER_NAME]
  if (!isObject(server)) return [`.mcp.json: mcpServers.${MCP_SERVER_NAME} is required`]
  return [
    ...check(
      sameSet(Object.keys(servers), [MCP_SERVER_NAME]),
      '.mcp.json: only the peers server is expected',
    ),
    ...check(server.command === CLAUDE_SHIM_COMMAND, `.mcp.json: command must be ${CLAUDE_SHIM_COMMAND}`),
    ...check(
      sameList(server.args, ['mcp', '--surface', 'claude-code']),
      '.mcp.json: args must be mcp --surface claude-code',
    ),
  ]
}

const validateHandler = (event: string, handler: unknown): Issues => {
  const where = `hooks.json ${event}`
  if (!isObject(handler)) return [`${where}: handler must be an object`]
  const args = Array.isArray(handler.args) ? handler.args : []
  const sub = String(args[1])
  const shape = [
    ...check(handler.type === 'command', `${where}: handler type must be "command"`),
    ...check(
      handler.command === CLAUDE_SHIM_COMMAND,
      `${where}: command must be the shim ${CLAUDE_SHIM_COMMAND}`,
    ),
    ...check(
      sameList(args, ['hook', sub, '--agent', 'claude-code']),
      `${where}: args must be hook <cmd> --agent claude-code`,
    ),
    ...check(
      (CLAUDE_HOOK_COMMANDS as readonly string[]).includes(sub),
      `${where}: unknown hook command "${sub}"`,
    ),
  ]
  const isWaiter = sub === 'wait'
  const timing = isWaiter
    ? [
        ...check(
          handler.async === true && handler.asyncRewake === true,
          `${where}: waiter needs async + asyncRewake`,
        ),
        ...check(
          typeof handler.timeout === 'number' && handler.timeout >= MIN_WAITER_TIMEOUT_SEC,
          `${where}: waiter timeout must be >= ${MIN_WAITER_TIMEOUT_SEC}s`,
        ),
      ]
    : check(
        handler.async === undefined && handler.asyncRewake === undefined,
        `${where}: ${sub} must be synchronous`,
      )
  return [...shape, ...timing]
}

const handlersOf = (
  groups: unknown,
): readonly { readonly matcher: unknown; readonly handlers: readonly unknown[] }[] =>
  (Array.isArray(groups) ? groups : []).map((group) => ({
    matcher: isObject(group) ? group.matcher : undefined,
    handlers: isObject(group) && Array.isArray(group.hooks) ? group.hooks : [],
  }))

const subcommand = (handler: unknown): string =>
  isObject(handler) && Array.isArray(handler.args) ? String(handler.args[1]) : ''

/** The PermissionRequest matcher must match exactly the auto-approved peers tools. */
export const validatePermissionMatcher = (matcher: unknown): Issues => {
  if (typeof matcher !== 'string') return ['hooks.json PermissionRequest: a matcher is required']
  let pattern: RegExp
  try {
    pattern = new RegExp(matcher)
  } catch {
    return [`hooks.json PermissionRequest: invalid matcher regex ${matcher}`]
  }
  const matched = PEERS_TOOLS.map((tool) => tool.name).filter((tool) =>
    pattern.test(claudeCodeToolName(tool)),
  )
  const others = ['Bash', 'Write', `mcp__other__${AUTO_APPROVED_TOOLS[0]}`].filter((name) =>
    pattern.test(name),
  )
  return [
    ...check(
      sameSet(matched, AUTO_APPROVED_TOOLS),
      `hooks.json PermissionRequest: matcher must match only ${AUTO_APPROVED_TOOLS.join(', ')}`,
    ),
    ...check(others.length === 0, `hooks.json PermissionRequest: matcher also matches ${others.join(', ')}`),
  ]
}

export const validateClaudeHooks = (config: JsonObject): Issues => {
  const events = isObject(config.hooks) ? config.hooks : undefined
  if (!events) return ['hooks.json: top-level "hooks" object is required']
  const eventIssues = check(
    sameSet(Object.keys(events), Object.keys(CLAUDE_EVENT_COMMANDS)),
    `hooks.json: events must be ${Object.keys(CLAUDE_EVENT_COMMANDS).join(', ')}`,
  )
  const perEvent = Object.entries(CLAUDE_EVENT_COMMANDS).flatMap(([event, expected]) => {
    const groups = handlersOf(events[event])
    const handlers = groups.flatMap((group) => group.handlers)
    const permission = event === 'PermissionRequest' ? validatePermissionMatcher(groups[0]?.matcher) : []
    const allSources =
      event === 'SessionStart'
        ? check(
            groups.every((group) => group.matcher === undefined),
            'hooks.json SessionStart: must fire for every source (no matcher)',
          )
        : []
    return [
      ...check(
        sameSet(handlers.map(subcommand), expected),
        `hooks.json ${event}: must run ${expected.join(' + ')}`,
      ),
      ...handlers.flatMap((handler) => validateHandler(event, handler)),
      ...permission,
      ...allSources,
    ]
  })
  return [...eventIssues, ...perEvent]
}

export const validateClaudeCodePlugin = async (dir: string): Promise<Issues> => {
  const [manifest, mcp, hooks] = await Promise.all([
    readJsonObject(join(dir, '.claude-plugin/plugin.json'), 'plugin.json'),
    readJsonObject(join(dir, '.mcp.json'), '.mcp.json'),
    readJsonObject(join(dir, 'hooks/hooks.json'), 'hooks.json'),
  ])
  const [skills, shim] = await Promise.all([
    validateSkills(dir, 'claude-code', PEERS_COMMANDS),
    validateShim(dir),
  ])
  return [
    ...manifest.issues,
    ...validateManifest(manifest.value),
    ...mcp.issues,
    ...validateMcp(mcp.value),
    ...hooks.issues,
    ...validateClaudeHooks(hooks.value),
    ...skills,
    ...shim,
  ].map((issue) => `claude-code: ${issue}`)
}
