#!/usr/bin/env bun
/**
 * Release binaries (docs/RELEASING.md):
 *
 *   bun run release:build                        every target → dist/release/ + SHA256SUMS
 *   bun packages/cli/scripts/release.ts --current --outfile packages/cli/dist/agent-peers
 *
 * Flags: --targets <id,…|all>  --current  --out <dir>  --outfile <file>
 *        --dashboard build|embed|skip  --adapters write|check|skip  --no-minify  --no-sourcemap
 */
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { type AdaptersMode, buildRelease, type DashboardMode, type ReleaseOptions } from './release/build'
import { currentTarget, parseTargets } from './release/targets'

const REPO_ROOT = join(import.meta.dir, '..', '..', '..')

const DASHBOARD_MODES: readonly DashboardMode[] = ['build', 'embed', 'skip']
const ADAPTERS_MODES: readonly AdaptersMode[] = ['write', 'check', 'skip']

function oneOf<T extends string>(
  flag: string,
  value: string | undefined,
  allowed: readonly T[],
  fallback: T,
): T {
  if (value === undefined) return fallback
  const found = allowed.find((mode) => mode === value)
  if (found === undefined) throw new Error(`--${flag} must be one of ${allowed.join(', ')}`)
  return found
}

/** argv (after the script) → build options; relative paths resolve against `cwd`. */
export function parseReleaseArgs(argv: readonly string[], cwd: string = process.cwd()): ReleaseOptions {
  const { values } = parseArgs({
    args: [...argv],
    options: {
      targets: { type: 'string' },
      current: { type: 'boolean', default: false },
      out: { type: 'string' },
      outfile: { type: 'string' },
      dashboard: { type: 'string' },
      adapters: { type: 'string' },
      'no-minify': { type: 'boolean', default: false },
      'no-sourcemap': { type: 'boolean', default: false },
    },
    strict: true,
  })
  const targets = values.current ? [currentTarget()] : parseTargets(values.targets ?? 'all')
  return {
    repoRoot: REPO_ROOT,
    outDir: values.out === undefined ? join(REPO_ROOT, 'dist', 'release') : resolve(cwd, values.out),
    targets,
    // A full release embeds a fresh dashboard; a single dev binary embeds whatever is built.
    dashboard: oneOf('dashboard', values.dashboard, DASHBOARD_MODES, values.current ? 'embed' : 'build'),
    adapters: oneOf('adapters', values.adapters, ADAPTERS_MODES, 'write'),
    minify: !values['no-minify'],
    sourcemap: !values['no-sourcemap'],
    outfile: values.outfile === undefined ? undefined : resolve(cwd, values.outfile),
    log: (line) => process.stdout.write(`${line}\n`),
  }
}

if (import.meta.main) {
  try {
    const result = await buildRelease(parseReleaseArgs(process.argv.slice(2)))
    for (const artifact of result.artifacts) process.stdout.write(`built ${artifact.path}\n`)
    if (result.sums !== undefined) process.stdout.write(`wrote ${result.sums}\n`)
  } catch (error) {
    process.stderr.write(`release: ${error instanceof Error ? error.message : String(error)}\n`)
    process.exit(1)
  }
}
