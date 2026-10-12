#!/usr/bin/env bun
/**
 * bun scripts/embed-adapters.ts           regenerate src/assets/adapters.generated.ts from adapters/
 * bun scripts/embed-adapters.ts --check   exit 1 when the generated module is stale
 *
 * Run by `bun run build` before `bun build --compile`, so the binary carries the plugin trees.
 */
import { dirname, join } from 'node:path'
import { runEmbed } from '../src/assets/embed'

const cliDir = join(dirname(Bun.fileURLToPath(import.meta.url)), '..')
const result = await runEmbed(join(cliDir, '..', '..', 'adapters'), cliDir, process.argv.includes('--check'))
const stream = result.code === 0 ? process.stdout : process.stderr
stream.write(`${result.message}\n`)
process.exit(result.code)
