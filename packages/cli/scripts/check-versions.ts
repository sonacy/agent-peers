#!/usr/bin/env bun
/**
 * bun packages/cli/scripts/check-versions.ts [--expect <version>]
 * exits 1 unless every package.json, adapter plugin.json and ADAPTER_VERSION equal <version>
 * (default: packages/cli/package.json).
 */
import { join } from 'node:path'
import { runCheckVersions } from './release/versions'

const at = process.argv.indexOf('--expect')
const expected = at === -1 ? undefined : process.argv[at + 1]?.replace(/^v/, '')
const result = await runCheckVersions(join(import.meta.dir, '..', '..', '..'), expected)
const stream = result.code === 0 ? process.stdout : process.stderr
stream.write(`${result.message}\n`)
process.exit(result.code)
