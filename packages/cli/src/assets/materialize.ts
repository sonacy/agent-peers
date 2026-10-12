/**
 * Writes the embedded adapter trees to disk (ARCHITECTURE §4 step 3, §9):
 *
 *   <home>/plugins/<version>/
 *     marketplace/                 Claude Code marketplace `agent-peers` (.claude-plugin/marketplace.json)
 *       plugins/peers/             the Claude Code plugin tree
 *     codex-marketplace/           Codex marketplace `agent-peers` (.agents/plugins/marketplace.json)
 *       plugins/peers/             the Codex plugin tree
 *     claude-desktop/              Desktop template, server instructions, README (reference only)
 *
 * Every `bin/agent-peers` shim is rewritten to default to the absolute installed binary, so the
 * plugins work whatever the agent's PATH or AGENT_PEERS_HOME (GUI apps get a minimal env).
 */
import { chmod, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join, relative, sep } from 'node:path'
import { EMBEDDED_ADAPTERS } from './adapters.generated'
import type { EmbeddedFile } from './embed'

export const MARKETPLACE_NAME = 'agent-peers'
export const PLUGIN_NAME = 'peers'
export const PLUGIN_ID = `${PLUGIN_NAME}@${MARKETPLACE_NAME}`
export const SHIM_PATH = 'bin/agent-peers'

export type PluginTree = 'claude-code' | 'codex' | 'claude-desktop'

export interface PluginLayout {
  readonly root: string
  readonly claudeMarketplace: string
  readonly claudePlugin: string
  readonly codexMarketplace: string
  readonly codexPlugin: string
  readonly desktopDir: string
}

export function pluginLayout(home: string, version: string): PluginLayout {
  const root = join(home, 'plugins', version)
  const claudeMarketplace = join(root, 'marketplace')
  const codexMarketplace = join(root, 'codex-marketplace')
  return {
    root,
    claudeMarketplace,
    claudePlugin: join(claudeMarketplace, 'plugins', PLUGIN_NAME),
    codexMarketplace,
    codexPlugin: join(codexMarketplace, 'plugins', PLUGIN_NAME),
    desktopDir: join(root, 'claude-desktop'),
  }
}

/** The shim line that picks the binary; replaced by an absolute default at install time. */
// biome-ignore lint/suspicious/noTemplateCurlyInString: POSIX shell parameter expansion, not a template
export const SHIM_BIN_LINE = 'bin="${AGENT_PEERS_BIN:-$home/bin/current}"'

/** POSIX single-quoting. */
export const shQuote = (text: string): string => `'${text.replace(/'/g, `'\\''`)}'`

/** The shim with its default binary pinned to `binaryPath` (AGENT_PEERS_BIN still wins). */
export function rewriteShim(text: string, binaryPath: string): string {
  if (!text.includes(SHIM_BIN_LINE)) throw new Error(`${SHIM_PATH}: unexpected shim, cannot pin the binary`)
  const pinned = [
    `# Pinned by agent-peers add: the binary this plugin version was installed with.`,
    `installed_bin=${shQuote(binaryPath)}`,
    // biome-ignore lint/suspicious/noTemplateCurlyInString: POSIX shell parameter expansion
    'bin="${AGENT_PEERS_BIN:-$installed_bin}"',
  ].join('\n')
  return text.replace(SHIM_BIN_LINE, pinned)
}

/** Codex marketplace manifest (`.agents/plugins/marketplace.json`; local sources start with `./`). */
export function codexMarketplaceManifest(): string {
  const manifest = {
    name: MARKETPLACE_NAME,
    interface: { displayName: 'agent-peers' },
    plugins: [
      {
        name: PLUGIN_NAME,
        source: { source: 'local', path: `./plugins/${PLUGIN_NAME}` },
        policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' },
        category: 'Developer Tools',
      },
    ],
  }
  return `${JSON.stringify(manifest, null, 2)}\n`
}

export interface TreeFile {
  /** Path inside the destination tree. */
  readonly path: string
  readonly mode: number
  readonly content: Buffer
}

/** The files of one embedded tree, with paths relative to the tree and shims pinned. */
export function treeFiles(
  tree: PluginTree,
  binaryPath: string,
  files: readonly EmbeddedFile[] = EMBEDDED_ADAPTERS,
): readonly TreeFile[] {
  const prefix = `${tree}/`
  return files
    .filter((file) => file.path.startsWith(prefix))
    .map((file) => {
      const path = file.path.slice(prefix.length)
      const raw = Buffer.from(file.base64, 'base64')
      const content = path === SHIM_PATH ? Buffer.from(rewriteShim(raw.toString('utf8'), binaryPath)) : raw
      return { path, mode: file.mode, content }
    })
}

/** One embedded file by its adapters-relative path. */
export function embeddedFile(path: string, files: readonly EmbeddedFile[] = EMBEDDED_ADAPTERS): Buffer {
  const file = files.find((entry) => entry.path === path)
  if (!file) throw new Error(`embedded adapter file missing: ${path}`)
  return Buffer.from(file.base64, 'base64')
}

async function listFilesRecursive(dir: string): Promise<readonly string[]> {
  try {
    const entries = await readdir(dir, { recursive: true, withFileTypes: true })
    return entries
      .filter((entry) => entry.isFile() || entry.isSymbolicLink())
      .map((entry) => relative(dir, join(entry.parentPath, entry.name)).split(sep).join('/'))
  } catch {
    return []
  }
}

async function writeIfChanged(path: string, content: Buffer, mode: number): Promise<boolean> {
  const current = await readFile(path).catch(() => undefined)
  if (current?.equals(content)) {
    await chmod(path, mode)
    return false
  }
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, content, { mode })
  await chmod(path, mode)
  return true
}

/**
 * Makes `dest` hold exactly `files` (extra files are removed). Unchanged files are not rewritten,
 * so a plugin an agent is reading in place is left alone. Returns how many files were written.
 */
export async function syncTree(dest: string, files: readonly TreeFile[]): Promise<number> {
  const expected = new Set(files.map((file) => file.path))
  const extra = (await listFilesRecursive(dest)).filter((path) => !expected.has(path))
  await Promise.all(extra.map((path) => rm(join(dest, path), { force: true })))
  const written = await Promise.all(
    files.map((file) => writeIfChanged(join(dest, file.path), file.content, file.mode)),
  )
  return written.filter(Boolean).length
}

/** Writes every plugin tree for `version` under `<home>/plugins/<version>`. Idempotent. */
export async function materializePlugins(
  home: string,
  version: string,
  binaryPath: string,
  files: readonly EmbeddedFile[] = EMBEDDED_ADAPTERS,
): Promise<PluginLayout> {
  const layout = pluginLayout(home, version)
  const claudeManifest = embeddedFile('marketplace/.claude-plugin/marketplace.json', files)
  await Promise.all([
    syncTree(layout.claudePlugin, treeFiles('claude-code', binaryPath, files)),
    syncTree(layout.codexPlugin, treeFiles('codex', binaryPath, files)),
    syncTree(layout.desktopDir, treeFiles('claude-desktop', binaryPath, files)),
    writeIfChanged(
      join(layout.claudeMarketplace, '.claude-plugin', 'marketplace.json'),
      claudeManifest,
      0o644,
    ),
    writeIfChanged(
      join(layout.codexMarketplace, '.agents', 'plugins', 'marketplace.json'),
      Buffer.from(codexMarketplaceManifest()),
      0o644,
    ),
  ])
  return layout
}
