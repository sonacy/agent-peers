/**
 * Shared install steps (ARCHITECTURE §4 steps 3–4, ONBOARDING §3 step 3): copy the binary, write
 * the plugin trees, create the home and a default config, and selftest the installed bridge.
 */
import { LocalHome } from '@agent-peers/core'
import type { Sys } from '../agents/types'
import { binaryPaths, installBinary } from '../assets/binary'
import { materializePlugins, pluginLayout } from '../assets/materialize'
import { formatArgv } from './exec'
import type { InstallContext } from './types'

/** The context for planning, status and removal: paths only, nothing written. */
export function installContext(sys: Sys, home: string, version: string): InstallContext {
  const paths = binaryPaths(home, version)
  return {
    sys,
    home,
    version,
    binary: paths.versioned,
    currentBinary: paths.current,
    layout: pluginLayout(home, version),
  }
}

export interface Prepared {
  readonly ctx: InstallContext
  readonly lines: readonly string[]
}

/** Copies `source` into the home, materializes the plugins, and writes a default config.json once. */
export async function prepareInstall(
  sys: Sys,
  home: string,
  version: string,
  source: string,
): Promise<Prepared> {
  const local = new LocalHome({ root: home, userHome: sys.home })
  await local.ensure()
  const binary = await installBinary(source, home, version)
  const ctx = installContext(sys, home, version)
  await materializePlugins(home, version, binary.versioned)
  const configCreated = !(await sys.exists(local.paths.config))
  if (configCreated) await local.writeConfig({})
  return {
    ctx,
    lines: [
      binary.changed
        ? `installed ${binary.versioned} (current -> ${version})`
        : `binary ${binary.versioned} up to date`,
      `plugins in ${ctx.layout.root}`,
      ...(configCreated ? [`wrote ${local.paths.config} (defaults: read-only peer turns)`] : []),
    ],
  }
}

/** A selftest must start the bridge and exit; anything slower is a broken install. */
export const SELFTEST_TIMEOUT_MS = 30_000

export interface SelftestResult {
  readonly ok: boolean
  readonly line: string
}

/** `<binary> mcp --surface <surface> --selftest`. */
export async function selftest(sys: Sys, binary: string, surface: string): Promise<SelftestResult> {
  const argv = [binary, 'mcp', '--surface', surface, '--selftest']
  const result = await sys.run(argv, { timeoutMs: SELFTEST_TIMEOUT_MS })
  const output = `${result.stderr}\n${result.stdout}`.trim().split('\n').at(-1) ?? ''
  if (result.code === 0) return { ok: true, line: `selftest ${surface}: ${output || 'ok'}` }
  const reason = result.timedOut ? 'timed out' : output || `exit code ${result.code}`
  return { ok: false, line: `selftest ${surface} failed: $ ${formatArgv(argv)} -> ${reason}` }
}
