#!/usr/bin/env node
// @ts-check
'use strict'
/** `npx @agent-peers/cli …` / `bunx @agent-peers/cli …`: execs this platform's prebuilt binary. */
const { resolveBinary } = require('../lib/platform.js')
const { ensureExecutable, run } = require('../lib/run.js')

let binary
try {
  binary = resolveBinary({ platform: process.platform, arch: process.arch, resolve: require.resolve })
  ensureExecutable(binary)
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  process.exit(1)
}
run(binary, process.argv.slice(2))
