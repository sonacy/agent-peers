/**
 * Stages the npm packages for publishing (ARCHITECTURE §9): one `@agent-peers/cli-<platform>-<arch>`
 * package per target, filled from npm/platform/ and carrying its release binary, plus the
 * `@agent-peers/cli` launcher from npm/cli/, every version stamped to the release version.
 *
 *   <outDir>/cli-darwin-arm64/{package.json,README.md,bin/agent-peers}
 *   …
 *   <outDir>/cli/{package.json,README.md,bin/,lib/}
 *
 * Publish the platform packages first (`<outDir>/cli-*`), then `<outDir>/cli`.
 */
import { chmod, copyFile, cp, mkdir, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { parseSums, SUMS_FILE, sha256File } from './checksums'
import { assetName, npmBinaryName, npmPackageName, RELEASE_TARGETS, type ReleaseTarget } from './targets'

const SEMVER = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/

export interface StageOptions {
  readonly repoRoot: string
  /** Where the release binaries and SHA256SUMS are (dist/release). */
  readonly releaseDir: string
  readonly outDir: string
  readonly version: string
  readonly targets?: readonly ReleaseTarget[]
}

export interface StagedPackage {
  readonly name: string
  readonly dir: string
}

type Json = Record<string, unknown>

/** Fills `{{platform}}` / `{{arch}}` in a template file's text. */
export function fillTemplate(text: string, target: ReleaseTarget): string {
  return text.replaceAll('{{platform}}', target.nodePlatform).replaceAll('{{arch}}', target.arch)
}

async function readJson(path: string): Promise<Json> {
  const parsed: unknown = JSON.parse(await readFile(path, 'utf8'))
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${path}: expected a JSON object`)
  }
  return parsed as Json
}

const writeJson = (path: string, value: Json): Promise<number> =>
  Bun.write(path, `${JSON.stringify(value, null, 2)}\n`)

/** The SHA256SUMS entries, or undefined when the release dir has none. */
async function releaseSums(releaseDir: string): Promise<ReadonlyMap<string, string> | undefined> {
  const file = Bun.file(join(releaseDir, SUMS_FILE))
  if (!(await file.exists())) return undefined
  return new Map(parseSums(await file.text()).map((sum) => [sum.name, sum.sha256]))
}

async function verifiedBinary(
  options: StageOptions,
  target: ReleaseTarget,
  sums?: ReadonlyMap<string, string>,
) {
  const path = join(options.releaseDir, assetName(target))
  if (!(await Bun.file(path).exists())) throw new Error(`missing release binary ${path} (run release:build)`)
  const expected = sums?.get(assetName(target))
  if (sums !== undefined && expected !== (await sha256File(path))) {
    throw new Error(`${assetName(target)} does not match ${SUMS_FILE}`)
  }
  return path
}

async function stagePlatform(
  options: StageOptions,
  target: ReleaseTarget,
  sums?: ReadonlyMap<string, string>,
) {
  const template = join(options.repoRoot, 'npm', 'platform')
  const dir = join(options.outDir, `cli-${target.nodePlatform}-${target.arch}`)
  await mkdir(join(dir, 'bin'), { recursive: true })
  const pkg = JSON.parse(fillTemplate(await readFile(join(template, 'package.json'), 'utf8'), target)) as Json
  await writeJson(join(dir, 'package.json'), { ...pkg, version: options.version })
  await Bun.write(
    join(dir, 'README.md'),
    fillTemplate(await readFile(join(template, 'README.md'), 'utf8'), target),
  )
  const binary = join(dir, 'bin', npmBinaryName(target))
  await copyFile(await verifiedBinary(options, target, sums), binary)
  await chmod(binary, 0o755)
  return { name: npmPackageName(target), dir }
}

async function stageLauncher(
  options: StageOptions,
  targets: readonly ReleaseTarget[],
): Promise<StagedPackage> {
  const source = join(options.repoRoot, 'npm', 'cli')
  const dir = join(options.outDir, 'cli')
  await mkdir(dir, { recursive: true })
  await cp(join(source, 'bin'), join(dir, 'bin'), { recursive: true })
  await cp(join(source, 'lib'), join(dir, 'lib'), { recursive: true })
  await copyFile(join(source, 'README.md'), join(dir, 'README.md'))
  await chmod(join(dir, 'bin', 'agent-peers.js'), 0o755)
  const pkg = await readJson(join(source, 'package.json'))
  const optionalDependencies = Object.fromEntries(targets.map((t) => [npmPackageName(t), options.version]))
  await writeJson(join(dir, 'package.json'), { ...pkg, version: options.version, optionalDependencies })
  return { name: String(pkg.name), dir }
}

/** Stages every package; returns them in publish order (platform packages, then the launcher). */
export async function stageNpm(options: StageOptions): Promise<readonly StagedPackage[]> {
  if (!SEMVER.test(options.version)) throw new Error(`version must be semver, got ${options.version}`)
  const targets = options.targets ?? RELEASE_TARGETS
  const sums = await releaseSums(options.releaseDir)
  await rm(options.outDir, { recursive: true, force: true })
  const platforms: StagedPackage[] = []
  for (const target of targets) platforms.push(await stagePlatform(options, target, sums))
  return [...platforms, await stageLauncher(options, targets)]
}

/** The CLI package version: release binaries report it, so the npm version must equal it. */
export async function cliVersion(repoRoot: string): Promise<string> {
  const pkg = await readJson(join(repoRoot, 'packages', 'cli', 'package.json'))
  if (typeof pkg.version !== 'string') throw new Error('packages/cli/package.json has no version')
  return pkg.version
}

/** `v0.2.0` or `0.2.0` → `0.2.0`, refusing anything that differs from the CLI version. */
export function releaseVersion(requested: string | undefined, packageVersion: string): string {
  if (requested === undefined) return packageVersion
  const version = requested.replace(/^v/, '')
  if (version !== packageVersion) {
    throw new Error(`release version ${version} != packages/cli/package.json version ${packageVersion}`)
  }
  return version
}
