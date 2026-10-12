/**
 * The release build: embed the adapter trees, optionally build the dashboard, generate the entry,
 * compile every target into `<outDir>/agent-peers-<os>-<arch>[.exe]` and write `SHA256SUMS`.
 */
import { copyFile, mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { runEmbed } from '../../src/assets/embed'
import { SUMS_FILE, writeSums } from './checksums'
import { compileTarget, runCommand } from './compile'
import { writeEntry } from './entry'
import { assetName, type ReleaseTarget } from './targets'

/** `build`: run the dashboard's build first; `embed`: embed whatever it last built; `skip`: none. */
export type DashboardMode = 'build' | 'embed' | 'skip'
/** `write`: regenerate adapters.generated.ts; `check`: fail when it is stale; `skip`: trust it. */
export type AdaptersMode = 'write' | 'check' | 'skip'

export interface ReleaseOptions {
  readonly repoRoot: string
  readonly outDir: string
  readonly targets: readonly ReleaseTarget[]
  readonly dashboard: DashboardMode
  readonly adapters: AdaptersMode
  readonly minify: boolean
  readonly sourcemap: boolean
  /** Single target only: write the binary here and skip SHA256SUMS (the `cli build` dev binary). */
  readonly outfile?: string
  /** A module exporting `dashboardAssets()` to embed instead of packages/dashboard (tests, forks). */
  readonly dashboardModule?: string
  readonly bun?: string
  readonly log?: (line: string) => void
}

export interface ReleaseArtifact {
  readonly target: ReleaseTarget
  readonly path: string
}

export interface ReleaseResult {
  readonly artifacts: readonly ReleaseArtifact[]
  /** Undefined with `outfile`. */
  readonly sums?: string
}

export const cliDir = (repoRoot: string): string => join(repoRoot, 'packages', 'cli')
export const dashboardDir = (repoRoot: string): string => join(repoRoot, 'packages', 'dashboard')

async function prepareAdapters(options: ReleaseOptions): Promise<void> {
  if (options.adapters === 'skip') return
  const result = await runEmbed(
    join(options.repoRoot, 'adapters'),
    cliDir(options.repoRoot),
    options.adapters === 'check',
  )
  if (result.code !== 0) throw new Error(result.message)
  options.log?.(result.message)
}

/** The dashboard index module to embed, after building it when asked; undefined when absent. */
export async function prepareDashboard(options: ReleaseOptions): Promise<string | undefined> {
  if (options.dashboard === 'skip') return undefined
  if (options.dashboardModule !== undefined) return options.dashboardModule
  const dir = dashboardDir(options.repoRoot)
  const index = join(dir, 'src', 'index.ts')
  if (!(await Bun.file(index).exists())) {
    options.log?.('dashboard: package not present, building without it')
    return undefined
  }
  if (options.dashboard === 'build') {
    const result = await runCommand([options.bun ?? process.execPath, 'run', 'build'], dir)
    if (result.code !== 0) throw new Error(`dashboard build failed (exit ${result.code}):\n${result.output}`)
    const last = result.stdout.trim().split('\n').at(-1)
    options.log?.(last === undefined || last === '' ? 'dashboard: built' : last)
  }
  return index
}

function validate(options: ReleaseOptions): void {
  if (options.targets.length === 0) throw new Error('no targets to build')
  if (options.outfile !== undefined && options.targets.length !== 1) {
    throw new Error('--outfile needs exactly one target')
  }
}

async function compileAll(options: ReleaseOptions, entry: string, work: string): Promise<ReleaseArtifact[]> {
  const artifacts: ReleaseArtifact[] = []
  for (const target of options.targets) {
    // Each target compiles in its own dir: --sourcemap leaves a .map beside the outfile.
    const scratch = join(work, target.id)
    await mkdir(scratch, { recursive: true })
    const built = join(scratch, assetName(target))
    options.log?.(`compiling ${target.id} (${target.bunTarget})`)
    await compileTarget({
      entry,
      target,
      outfile: built,
      minify: options.minify,
      sourcemap: options.sourcemap,
      bun: options.bun,
      cwd: options.repoRoot,
    })
    const path = options.outfile ?? join(options.outDir, assetName(target))
    await mkdir(join(path, '..'), { recursive: true })
    await copyFile(built, path)
    artifacts.push({ target, path })
  }
  return artifacts
}

export async function buildRelease(options: ReleaseOptions): Promise<ReleaseResult> {
  validate(options)
  await prepareAdapters(options)
  const dashboard = await prepareDashboard(options)
  await mkdir(options.outDir, { recursive: true })
  const work = join(options.outDir, `.build-${process.pid}`)
  try {
    const runtime = join(cliDir(options.repoRoot), 'scripts', 'release', 'runtime.ts')
    const entry = await writeEntry(work, { runtime, dashboard })
    const artifacts = await compileAll(options, entry, work)
    if (options.outfile !== undefined) return { artifacts }
    await writeSums(
      options.outDir,
      artifacts.map((artifact) => artifact.path),
    )
    return { artifacts, sums: join(options.outDir, SUMS_FILE) }
  } finally {
    await rm(work, { recursive: true, force: true })
  }
}
