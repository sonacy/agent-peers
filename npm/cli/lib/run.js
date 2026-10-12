// @ts-check
'use strict'
/**
 * Runs the platform binary with the launcher's arguments and stdio, and mirrors its exit. Node has
 * no exec(), so the launcher stays as the parent: it forwards SIGTERM and SIGHUP (an agent stopping
 * an MCP server) and ignores SIGINT, which the terminal already delivers to the whole process
 * group (forwarding it would interrupt a graceful `hub` stop twice).
 */
const { spawn } = require('node:child_process')
const fs = require('node:fs')

const FORWARDED = Object.freeze(['SIGTERM', 'SIGHUP'])

/**
 * @typedef {object} ExitTarget
 * @property {(code: number) => void} exit
 * @property {(signal: NodeJS.Signals) => void} kill  re-raise a signal on the launcher itself
 * @property {(signal: NodeJS.Signals, handler: () => void) => void} on
 * @property {(signal: NodeJS.Signals, handler: () => void) => void} off
 */

/** @type {ExitTarget} */
const processTarget = {
  exit: process.exit.bind(process),
  kill: process.kill.bind(process, process.pid),
  on: process.on.bind(process),
  off: process.off.bind(process),
}

/**
 * Some package managers drop the executable bit when unpacking; restore it (POSIX only).
 * @param {string} binary
 * @param {string} [platform]
 */
function ensureExecutable(binary, platform = process.platform) {
  if (platform === 'win32') return
  try {
    fs.accessSync(binary, fs.constants.X_OK)
  } catch {
    fs.chmodSync(binary, 0o755)
  }
}

/**
 * @param {string} binary
 * @param {readonly string[]} args
 * @param {ExitTarget} [target]
 * @returns {import('node:child_process').ChildProcess}
 */
function run(binary, args, target = processTarget) {
  const child = spawn(binary, [...args], { stdio: 'inherit', windowsHide: false })
  /** @type {Array<[NodeJS.Signals, () => void]>} */
  const handlers = [...FORWARDED, 'SIGINT'].map((name) => {
    const signal = /** @type {NodeJS.Signals} */ (name)
    return [signal, () => (FORWARDED.includes(signal) ? child.kill(signal) : undefined)]
  })
  for (const [signal, handler] of handlers) target.on(signal, handler)
  const detach = () => {
    for (const [signal, handler] of handlers) target.off(signal, handler)
  }
  child.on('error', (error) => {
    detach()
    process.stderr.write(`agent-peers: cannot run ${binary}: ${error.message}\n`)
    target.exit(1)
  })
  child.on('exit', (code, signal) => {
    detach()
    if (signal) target.kill(signal)
    else target.exit(code ?? 1)
  })
  return child
}

module.exports = { FORWARDED, ensureExecutable, run }
