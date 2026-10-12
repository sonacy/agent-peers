// @ts-check
'use strict'
/**
 * Finds the prebuilt `agent-peers` binary for this platform (ARCHITECTURE §9): `@agent-peers/cli`
 * lists every `@agent-peers/cli-<platform>-<arch>` package in `optionalDependencies`, and the
 * package manager installs only the one whose `os`/`cpu` match. Plain CommonJS with no
 * dependencies, so it runs under Node 18+ and Bun.
 */

const SCOPE = '@agent-peers'

/** `<process.platform>-<process.arch>` pairs that have a platform package. */
const SUPPORTED = Object.freeze(['darwin-arm64', 'darwin-x64', 'linux-x64', 'linux-arm64', 'win32-x64'])

/**
 * @param {string} platform
 * @param {string} arch
 * @returns {string | undefined}
 */
function packageName(platform, arch) {
  const key = `${platform}-${arch}`
  return SUPPORTED.includes(key) ? `${SCOPE}/cli-${key}` : undefined
}

/**
 * @param {string} platform
 * @returns {string}
 */
function binaryFile(platform) {
  return platform === 'win32' ? 'agent-peers.exe' : 'agent-peers'
}

/**
 * @typedef {object} ResolveInput
 * @property {string} platform
 * @property {string} arch
 * @property {(id: string) => string} resolve  `require.resolve`, from the launcher's location
 */

/**
 * The binary's absolute path. Throws an Error whose message tells the user what to do.
 * @param {ResolveInput} input
 * @returns {string}
 */
function resolveBinary(input) {
  const pkg = packageName(input.platform, input.arch)
  if (pkg === undefined) {
    throw new Error(
      `agent-peers has no prebuilt binary for ${input.platform}-${input.arch} ` +
        `(available: ${SUPPORTED.join(', ')}). See https://github.com/sonacy/agent-peers#install`,
    )
  }
  const id = `${pkg}/bin/${binaryFile(input.platform)}`
  try {
    return input.resolve(id)
  } catch {
    throw new Error(
      `agent-peers: the platform package ${pkg} is not installed. It is an optional dependency of ` +
        '@agent-peers/cli; reinstall without --no-optional / --omit=optional ' +
        '(or remove node_modules and the lockfile and install again).',
    )
  }
}

module.exports = { SCOPE, SUPPORTED, binaryFile, packageName, resolveBinary }
