#!/usr/bin/env bun
/**
 * bun adapters/build.ts            regenerate skills and Claude Desktop files, assemble the local marketplace
 * bun adapters/build.ts --check    fail (exit 1) if generated files are stale or any tree is invalid
 */
import { dirname, join } from 'node:path'
import { assembleMarketplace, writeGenerated } from './build-lib'
import { validateAdapters } from './validate'

export interface BuildResult {
  readonly code: number
  readonly lines: readonly string[]
}

export const runBuild = async (adaptersDir: string, args: readonly string[]): Promise<BuildResult> => {
  if (args.includes('--check')) {
    const issues = await validateAdapters(adaptersDir)
    return issues.length === 0
      ? { code: 0, lines: ['adapters: ok'] }
      : { code: 1, lines: issues.map((issue) => `adapters: ${issue}`) }
  }
  const written = await writeGenerated(adaptersDir)
  const plugin = await assembleMarketplace(adaptersDir, join(adaptersDir, 'marketplace'))
  const issues = await validateAdapters(adaptersDir)
  return {
    code: issues.length === 0 ? 0 : 1,
    lines: [
      ...written.map((path) => `wrote ${path}`),
      `assembled ${plugin}`,
      ...issues.map((issue) => `adapters: ${issue}`),
    ],
  }
}

if (import.meta.main) {
  const result = await runBuild(dirname(Bun.fileURLToPath(import.meta.url)), process.argv.slice(2))
  const stream = result.code === 0 ? process.stdout : process.stderr
  stream.write(`${result.lines.join('\n')}\n`)
  process.exit(result.code)
}
