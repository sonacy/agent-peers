/**
 * Build steps for the adapter trees:
 * - generated files (skills for both plugins, the Claude Desktop template and instructions) are written
 *   from TS sources and committed; `checkGenerated` reports drift;
 * - `assembleMarketplace` copies the Claude Code plugin under a local marketplace root, because a
 *   marketplace entry's `source` may not contain `..`.
 */
import { access, cp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { renderDesktopInstructions, renderDesktopTemplate } from './claude-desktop'
import { type GeneratedFile, skillFiles } from './skills'
import { PEERS_COMMANDS, PLUGIN_NAME } from './tools'

export const generatedFiles = (): readonly GeneratedFile[] => [
  ...skillFiles(),
  { path: 'claude-desktop/claude_desktop_config.template.json', content: renderDesktopTemplate() },
  { path: 'claude-desktop/server-instructions.md', content: renderDesktopInstructions() },
]

const readIfExists = async (path: string): Promise<string | undefined> => {
  try {
    return await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

/** Writes every generated file whose content changed. Returns the paths it wrote. */
export const writeGenerated = async (adaptersDir: string): Promise<readonly string[]> => {
  const results = await Promise.all(
    generatedFiles().map(async (file) => {
      const target = join(adaptersDir, file.path)
      if ((await readIfExists(target)) === file.content) return undefined
      await mkdir(dirname(target), { recursive: true })
      await writeFile(target, file.content)
      return file.path
    }),
  )
  return results.filter((path): path is string => path !== undefined)
}

const listDirs = async (dir: string): Promise<readonly string[]> => {
  try {
    const entries = await readdir(dir, { withFileTypes: true })
    return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
}

/** Skill directories that no command generates (left over after a rename, for example). */
const unexpectedSkillDirs = async (adaptersDir: string): Promise<readonly string[]> => {
  const known = new Set(PEERS_COMMANDS.map((command) => command.name))
  const perTree = await Promise.all(
    ['claude-code', 'codex'].map(async (tree) =>
      (await listDirs(join(adaptersDir, tree, 'skills')))
        .filter((name) => !known.has(name))
        .map((name) => `${tree}/skills/${name}: no command generates this skill`),
    ),
  )
  return perTree.flat()
}

/** Problems that `bun adapters/build.ts` would fix. Empty when the committed files are current. */
export const checkGenerated = async (adaptersDir: string): Promise<readonly string[]> => {
  const drift = await Promise.all(
    generatedFiles().map(async (file) => {
      const current = await readIfExists(join(adaptersDir, file.path))
      if (current === undefined) return `${file.path}: missing (run bun adapters/build.ts)`
      return current === file.content ? undefined : `${file.path}: stale (run bun adapters/build.ts)`
    }),
  )
  const extra = await unexpectedSkillDirs(adaptersDir)
  return [...drift.filter((problem): problem is string => problem !== undefined), ...extra]
}

/** Relative `source` of the plugin inside the local marketplace. */
export const MARKETPLACE_PLUGIN_SOURCE = `./plugins/${PLUGIN_NAME}`

/**
 * Copies `adapters/claude-code` to `<marketplaceDir>/plugins/peers`, replacing any previous copy.
 * File modes are preserved, so the shim stays executable.
 */
export const assembleMarketplace = async (adaptersDir: string, marketplaceDir: string): Promise<string> => {
  const source = join(adaptersDir, 'claude-code')
  await access(join(source, '.claude-plugin', 'plugin.json'))
  const target = join(marketplaceDir, MARKETPLACE_PLUGIN_SOURCE)
  await rm(target, { recursive: true, force: true })
  await mkdir(dirname(target), { recursive: true })
  await cp(source, target, { recursive: true, preserveTimestamps: true })
  return target
}
