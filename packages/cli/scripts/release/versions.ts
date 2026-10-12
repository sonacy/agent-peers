/**
 * One version everywhere (docs/RELEASING.md step 1): every workspace package.json, every adapter
 * plugin manifest and the bridge's ADAPTER_VERSION (which sessions publish on their card and the
 * hub compares with `--min-adapter`) must equal the release tag. A missed bump fails the release.
 */
import { join } from 'node:path'
import { ADAPTER_VERSION } from '@agent-peers/bridge'

export interface VersionEntry {
  /** Repo-relative file, or `ADAPTER_VERSION`. */
  readonly source: string
  readonly version: string | undefined
}

/** Manifests that carry the release version (globs, relative to the repo root). */
export const VERSIONED_GLOBS: readonly string[] = [
  'packages/*/package.json',
  'adapters/*/.claude-plugin/plugin.json',
  'adapters/*/.codex-plugin/plugin.json',
  'adapters/marketplace/plugins/*/.claude-plugin/plugin.json',
]

async function readVersion(path: string): Promise<string | undefined> {
  const parsed: unknown = await Bun.file(path).json()
  if (typeof parsed !== 'object' || parsed === null) return undefined
  const version = (parsed as { readonly version?: unknown }).version
  return typeof version === 'string' ? version : undefined
}

export async function collectVersions(
  root: string,
  adapterVersion: string = ADAPTER_VERSION,
): Promise<readonly VersionEntry[]> {
  const files: string[] = []
  for (const pattern of VERSIONED_GLOBS)
    for await (const file of new Bun.Glob(pattern).scan({ cwd: root, dot: true })) files.push(file)
  const sorted = [...new Set(files)].sort()
  const entries = await Promise.all(
    sorted.map(async (source) => ({ source, version: await readVersion(join(root, source)) })),
  )
  return [...entries, { source: 'ADAPTER_VERSION', version: adapterVersion }]
}

/** `<source>: <version> (expected <expected>)` for every entry that differs. */
export function versionMismatches(entries: readonly VersionEntry[], expected: string): readonly string[] {
  return entries
    .filter((entry) => entry.version !== expected)
    .map((entry) => `${entry.source}: ${entry.version ?? '(none)'} (expected ${expected})`)
}

export interface CheckResult {
  readonly code: number
  readonly message: string
}

/** Checks every version against `expected` (default: packages/cli/package.json). */
export async function runCheckVersions(root: string, expected?: string): Promise<CheckResult> {
  const entries = await collectVersions(root)
  const want = expected ?? (await readVersion(join(root, 'packages', 'cli', 'package.json'))) ?? ''
  const wrong = versionMismatches(entries, want)
  if (wrong.length === 0) return { code: 0, message: `all ${entries.length} versions are ${want}` }
  return { code: 1, message: [`version mismatch (bump them all, docs/RELEASING.md):`, ...wrong].join('\n') }
}
