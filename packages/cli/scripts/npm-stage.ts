#!/usr/bin/env bun
/**
 * bun run release:npm [--version v0.2.0] [--release dist/release] [--out dist/npm]
 *
 * Stamps the version into the npm packages, copies the release binaries into the platform packages
 * and writes publishable trees to dist/npm (docs/RELEASING.md). `--version` (e.g. the git tag) must
 * equal packages/cli/package.json's version.
 */
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { cliVersion, releaseVersion, type StageOptions, stageNpm } from './release/npm-stage'
import { parseTargets } from './release/targets'

const REPO_ROOT = join(import.meta.dir, '..', '..', '..')

export async function parseStageArgs(
  argv: readonly string[],
  cwd: string = process.cwd(),
): Promise<StageOptions> {
  const { values } = parseArgs({
    args: [...argv],
    options: {
      version: { type: 'string' },
      release: { type: 'string' },
      out: { type: 'string' },
      targets: { type: 'string' },
    },
    strict: true,
  })
  return {
    repoRoot: REPO_ROOT,
    releaseDir:
      values.release === undefined ? join(REPO_ROOT, 'dist', 'release') : resolve(cwd, values.release),
    outDir: values.out === undefined ? join(REPO_ROOT, 'dist', 'npm') : resolve(cwd, values.out),
    version: releaseVersion(values.version, await cliVersion(REPO_ROOT)),
    targets: parseTargets(values.targets ?? 'all'),
  }
}

if (import.meta.main) {
  try {
    const staged = await stageNpm(await parseStageArgs(process.argv.slice(2)))
    for (const pkg of staged) process.stdout.write(`${pkg.name}\t${pkg.dir}\n`)
  } catch (error) {
    process.stderr.write(`npm-stage: ${error instanceof Error ? error.message : String(error)}\n`)
    process.exit(1)
  }
}
