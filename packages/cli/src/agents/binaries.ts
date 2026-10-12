/**
 * Finding an agent's real binary (ARCHITECTURE §4 step 1): candidates from env overrides, PATH and
 * known install locations, wrapper shims (cmux) skipped, the first one that answers `--version` wins.
 */
import { delimiter, isAbsolute, join } from 'node:path'
import type { FoundBinary, Sys } from './types'
import { parseVersion } from './version'

/** `--version` must answer quickly; a hung binary is not the one to install with. */
export const VERSION_TIMEOUT_MS = 10_000

/** A shim script is small; anything bigger is a real binary. */
const MAX_SHIM_BYTES = 16 * 1024

/** Wrapper shims that shadow the real agent on PATH (cmux puts `claude`/`codex` shims there). */
const SHIM_PATH_PATTERN = /[/\\](?:\.cmuxterm|cmux-cli-shims)[/\\]/

export interface Candidate {
  readonly path: string
  readonly source: string
}

/** Every `name` executable on `$PATH`, in PATH order. */
export async function pathCandidates(sys: Sys, name: string): Promise<readonly Candidate[]> {
  const dirs = (sys.env.PATH ?? '').split(delimiter).filter((dir) => dir.length > 0 && isAbsolute(dir))
  const found: Candidate[] = []
  for (const dir of dirs) {
    const path = join(dir, name)
    if (await sys.isExecutable(path)) found.push({ path, source: 'PATH' })
  }
  return found
}

/** A wrapper shim: lives in a known shim dir, or is a small script that hands off to a wrapper. */
export async function isWrapperShim(sys: Sys, path: string, realPath: string): Promise<boolean> {
  if (SHIM_PATH_PATTERN.test(path) || SHIM_PATH_PATTERN.test(realPath)) return true
  const text = await sys.readText(realPath)
  if (text === undefined || text.length > MAX_SHIM_BYTES || !text.startsWith('#!')) return false
  return /cmux/i.test(text)
}

/** `<bin> --version`, parsed; undefined when it fails or prints no version. */
export async function readVersion(sys: Sys, path: string): Promise<string | undefined> {
  const result = await sys.run([path, '--version'], { timeoutMs: VERSION_TIMEOUT_MS })
  if (result.code !== 0) return undefined
  return parseVersion(result.stdout) ?? parseVersion(result.stderr)
}

/**
 * The first candidate that is not a wrapper shim and answers `--version`. Duplicates (the same
 * real binary reached through two paths) are probed once. `skipped` lists shims and dead binaries.
 */
export async function resolveBinary(
  sys: Sys,
  candidates: readonly Candidate[],
): Promise<{ readonly binary?: FoundBinary; readonly skipped: readonly string[] }> {
  const seen = new Set<string>()
  const skipped: string[] = []
  for (const candidate of candidates) {
    if (!(await sys.isExecutable(candidate.path))) continue
    const realPath = await sys.realpath(candidate.path)
    if (seen.has(realPath)) continue
    seen.add(realPath)
    if (await isWrapperShim(sys, candidate.path, realPath)) {
      skipped.push(`${candidate.path} (wrapper shim)`)
      continue
    }
    const version = await readVersion(sys, candidate.path)
    if (version === undefined) {
      skipped.push(`${candidate.path} (no --version answer)`)
      continue
    }
    return { binary: { path: candidate.path, realPath, version, source: candidate.source }, skipped }
  }
  return { skipped }
}

/** `CFBundle…` value from an app's Info.plist (XML, or binary through `plutil` on macOS). */
export async function plistValue(sys: Sys, plistPath: string, key: string): Promise<string | undefined> {
  const text = await sys.readText(plistPath)
  if (text === undefined) return undefined
  if (text.startsWith('bplist')) {
    if (sys.platform !== 'darwin') return undefined
    const result = await sys.run(['/usr/bin/plutil', '-extract', key, 'raw', '-o', '-', plistPath], {
      timeoutMs: VERSION_TIMEOUT_MS,
    })
    return result.code === 0 ? result.stdout.trim() || undefined : undefined
  }
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = new RegExp(`<key>${escaped}</key>\\s*<string>([^<]*)</string>`).exec(text)
  return match?.[1]?.trim() || undefined
}

export interface AppBundle {
  readonly path: string
  readonly bundleId: string
  readonly version?: string
}

/** The first app bundle named one of `names` in the app dirs whose bundle id is `bundleId`. */
export async function findApp(
  sys: Sys,
  names: readonly string[],
  bundleId: string,
): Promise<AppBundle | undefined> {
  for (const dir of sys.appDirs) {
    for (const name of names) {
      const path = join(dir, name)
      const plist = join(path, 'Contents', 'Info.plist')
      const id = await plistValue(sys, plist, 'CFBundleIdentifier')
      if (id !== bundleId) continue
      const version = await plistValue(sys, plist, 'CFBundleShortVersionString')
      return version === undefined ? { path, bundleId: id } : { path, bundleId: id, version }
    }
  }
  return undefined
}
