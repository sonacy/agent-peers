/** One `bun build --compile` per release target (ARCHITECTURE §9 "one binary"). */
import type { ReleaseTarget } from './targets'

export interface CompileOptions {
  readonly entry: string
  readonly target: ReleaseTarget
  readonly outfile: string
  readonly minify: boolean
  readonly sourcemap: boolean
  /** The bun executable (default: the one running this script). */
  readonly bun?: string
  readonly cwd?: string
}

export function compileArgv(options: CompileOptions): readonly string[] {
  return [
    options.bun ?? process.execPath,
    'build',
    options.entry,
    '--compile',
    `--target=${options.target.bunTarget}`,
    '--outfile',
    options.outfile,
    ...(options.minify ? ['--minify'] : []),
    ...(options.sourcemap ? ['--sourcemap'] : []),
  ]
}

export interface CommandResult {
  readonly code: number
  readonly stdout: string
  /** stdout then stderr, trimmed (for error messages). */
  readonly output: string
}

/** Runs `argv`, capturing stdout and stderr together. */
export async function runCommand(argv: readonly string[], cwd?: string): Promise<CommandResult> {
  const proc = Bun.spawn([...argv], { cwd, stdout: 'pipe', stderr: 'pipe', stdin: 'ignore' })
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return { code, stdout, output: `${stdout}${stderr}`.trim() }
}

export async function compileTarget(options: CompileOptions): Promise<void> {
  const argv = compileArgv(options)
  const result = await runCommand(argv, options.cwd)
  if (result.code !== 0) {
    throw new Error(`bun build failed for ${options.target.id} (exit ${result.code}):\n${result.output}`)
  }
}
