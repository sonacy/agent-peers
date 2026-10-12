/** Validates every adapter tree plus the generated files. Used by `bun adapters/build.ts --check` and tests. */
import { join } from 'node:path'
import { checkGenerated, MARKETPLACE_PLUGIN_SOURCE } from './build-lib'
import { DESKTOP_BINARY_PLACEHOLDER, DESKTOP_SERVER_INSTRUCTIONS, desktopServerEntry } from './claude-desktop'
import { DESKTOP_SERVER_NAME, MARKETPLACE_NAME, PLUGIN_NAME } from './tools'
import { validateClaudeCodePlugin } from './validate-claude'
import { validateCodexPlugin } from './validate-codex'
import {
  check,
  fileExists,
  type Issues,
  isNonEmptyString,
  isObject,
  type JsonObject,
  readJsonObject,
  readText,
  sameList,
} from './validate-common'

export const validateMarketplaceManifest = (manifest: JsonObject): Issues => {
  const plugins = Array.isArray(manifest.plugins) ? manifest.plugins : []
  const entry = plugins.find((plugin: unknown) => isObject(plugin) && plugin.name === PLUGIN_NAME)
  const source = isObject(entry) ? entry.source : undefined
  return [
    ...check(manifest.name === MARKETPLACE_NAME, `marketplace.json: name must be "${MARKETPLACE_NAME}"`),
    ...check(
      isObject(manifest.owner) && isNonEmptyString(manifest.owner.name),
      'marketplace.json: owner.name is required',
    ),
    ...check(entry !== undefined, `marketplace.json: must list the "${PLUGIN_NAME}" plugin`),
    ...check(
      source === MARKETPLACE_PLUGIN_SOURCE,
      `marketplace.json: ${PLUGIN_NAME} source must be ${MARKETPLACE_PLUGIN_SOURCE}`,
    ),
  ]
}

export const validateMarketplace = async (dir: string): Promise<Issues> => {
  const manifest = await readJsonObject(join(dir, '.claude-plugin/marketplace.json'), 'marketplace.json')
  return [...manifest.issues, ...validateMarketplaceManifest(manifest.value)].map(
    (issue) => `marketplace: ${issue}`,
  )
}

export const validateDesktop = async (dir: string): Promise<Issues> => {
  const [template, instructions, readme] = await Promise.all([
    readJsonObject(join(dir, 'claude_desktop_config.template.json'), 'template'),
    readText(join(dir, 'server-instructions.md')),
    fileExists(join(dir, 'README.md')),
  ])
  const servers = isObject(template.value.mcpServers) ? template.value.mcpServers : {}
  const entry = servers[DESKTOP_SERVER_NAME]
  const expected = desktopServerEntry(DESKTOP_BINARY_PLACEHOLDER)
  return [
    ...template.issues,
    ...check(isObject(entry), `template: mcpServers["${DESKTOP_SERVER_NAME}"] is required`),
    ...check(
      isObject(entry) && sameList(entry.args, expected.args),
      'template: args must be mcp --surface claude-desktop',
    ),
    ...check(instructions?.trim() === DESKTOP_SERVER_INSTRUCTIONS, 'server-instructions.md: out of date'),
    ...check(
      DESKTOP_SERVER_INSTRUCTIONS.includes('peers_inbox'),
      'instructions must tell Claude to check peers_inbox',
    ),
    ...check(readme, 'README.md: missing'),
  ].map((issue) => `claude-desktop: ${issue}`)
}

/** Every issue across `adapters/`. Empty means the trees are consistent. */
export const validateAdapters = async (adaptersDir: string): Promise<Issues> => {
  const results = await Promise.all([
    checkGenerated(adaptersDir),
    validateClaudeCodePlugin(join(adaptersDir, 'claude-code')),
    validateCodexPlugin(join(adaptersDir, 'codex')),
    validateDesktop(join(adaptersDir, 'claude-desktop')),
    validateMarketplace(join(adaptersDir, 'marketplace')),
  ])
  return results.flat()
}
