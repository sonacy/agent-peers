/**
 * Release targets (ARCHITECTURE §9): one `bun build --compile` per target. Release assets are named
 * `agent-peers-<os>-<arch>[.exe]` (what install.sh downloads); the npm platform packages use Node's
 * `process.platform`/`process.arch` names (`@agent-peers/cli-<platform>-<arch>`).
 */

export type ReleaseOs = 'darwin' | 'linux' | 'windows'
export type ReleaseArch = 'arm64' | 'x64'
export type NodePlatform = 'darwin' | 'linux' | 'win32'

export interface ReleaseTarget {
  /** `darwin-arm64`, also the `--targets` spelling. */
  readonly id: string
  readonly os: ReleaseOs
  readonly arch: ReleaseArch
  /**
   * `bun build --compile --target`. x64 uses Bun's `-baseline` build: the default x64 runtime needs
   * AVX2, which many VPS CPU models (qemu64) and Rosetta 2 do not provide.
   */
  readonly bunTarget: string
  readonly nodePlatform: NodePlatform
  /** `.exe` on Windows. */
  readonly ext: string
}

function target(os: ReleaseOs, arch: ReleaseArch): ReleaseTarget {
  const nodePlatform: NodePlatform = os === 'windows' ? 'win32' : os
  return Object.freeze({
    id: `${os}-${arch}`,
    os,
    arch,
    bunTarget: arch === 'x64' ? `bun-${os}-x64-baseline` : `bun-${os}-${arch}`,
    nodePlatform,
    ext: os === 'windows' ? '.exe' : '',
  })
}

export const RELEASE_TARGETS: readonly ReleaseTarget[] = Object.freeze([
  target('darwin', 'arm64'),
  target('darwin', 'x64'),
  target('linux', 'x64'),
  target('linux', 'arm64'),
  target('windows', 'x64'),
])

export const NPM_SCOPE = '@agent-peers'
export const LAUNCHER_PACKAGE = `${NPM_SCOPE}/cli`
export const BINARY_NAME = 'agent-peers'

/** `agent-peers-darwin-arm64`, `agent-peers-windows-x64.exe`. */
export function assetName(t: ReleaseTarget): string {
  return `${BINARY_NAME}-${t.id}${t.ext}`
}

/** `@agent-peers/cli-darwin-arm64`, `@agent-peers/cli-win32-x64`. */
export function npmPackageName(t: ReleaseTarget): string {
  return `${LAUNCHER_PACKAGE}-${t.nodePlatform}-${t.arch}`
}

/** The binary's file name inside its npm platform package (`bin/<name>`). */
export function npmBinaryName(t: ReleaseTarget): string {
  return `${BINARY_NAME}${t.ext}`
}

/** The target for a Node/Bun `process.platform` + `process.arch`, if it is released. */
export function targetFor(platform: string, arch: string): ReleaseTarget | undefined {
  return RELEASE_TARGETS.find((t) => t.nodePlatform === platform && t.arch === arch)
}

export function currentTarget(
  platform: string = process.platform,
  arch: string = process.arch,
): ReleaseTarget {
  const found = targetFor(platform, arch)
  if (found === undefined) throw new Error(`no release target for ${platform}-${arch}`)
  return found
}

/** `darwin-arm64,linux-x64` (or `all`) → targets, in release order; unknown ids are an error. */
export function parseTargets(spec: string): readonly ReleaseTarget[] {
  const ids = spec
    .split(',')
    .map((id) => id.trim())
    .filter((id) => id !== '')
  if (ids.length === 0 || ids.includes('all')) return RELEASE_TARGETS
  const unknown = ids.filter((id) => !RELEASE_TARGETS.some((t) => t.id === id))
  if (unknown.length > 0) {
    const known = RELEASE_TARGETS.map((t) => t.id).join(', ')
    throw new Error(`unknown target ${unknown.join(', ')} (known: ${known})`)
  }
  return RELEASE_TARGETS.filter((t) => ids.includes(t.id))
}
