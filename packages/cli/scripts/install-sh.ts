#!/usr/bin/env bun
/**
 * bun packages/cli/scripts/install-sh.ts           regenerate scripts/install.sh from the hub template
 * bun packages/cli/scripts/install-sh.ts --check   exit 1 when scripts/install.sh is stale
 */
import { join } from 'node:path'
import { runInstallSh } from './release/install-sh'

const result = await runInstallSh(join(import.meta.dir, '..', '..', '..'), process.argv.includes('--check'))
const stream = result.code === 0 ? process.stdout : process.stderr
stream.write(`${result.message}\n`)
process.exit(result.code)
