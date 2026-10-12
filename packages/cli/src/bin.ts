#!/usr/bin/env bun
/** The `agent-peers` binary: everything lives in command modules (program.ts). */
import { main } from './program'

/** A finished command exits once its output is flushed, even if a stray handle lingers. */
const EXIT_GRACE_MS = 1000

const code = await main(process.argv.slice(2))
if (code !== undefined) {
  process.exitCode = code
  setTimeout(() => process.exit(code), EXIT_GRACE_MS).unref()
}
