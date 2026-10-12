/**
 * The release binary's runtime glue. The generated release entry (entry.ts) statically imports the
 * dashboard module, so `bun build --compile` embeds the SPA; the CLI's own dynamic
 * `import('@agent-peers/dashboard')` cannot be followed by the bundler. This hands that module to
 * the hub command as its dashboard loader.
 */
import { assetsFromModule, type DashboardLoader } from '../../src/commands/hub-dashboard'
import type { CliIo } from '../../src/io'
import { type ExitCode, main, type ProgramDeps } from '../../src/program'

/** A loader over an already-imported dashboard module; a broken module is reported, not fatal. */
export function bundledDashboard(mod: unknown): DashboardLoader {
  return async (warn) => {
    try {
      return assetsFromModule(mod)
    } catch (error) {
      warn(`dashboard assets failed to load: ${String(error)}`)
      return undefined
    }
  }
}

/** Program deps for a release binary: the bundled dashboard when there is one. */
export function releaseDeps(dashboard: unknown): ProgramDeps {
  return dashboard === undefined ? {} : { hub: { run: { loadDashboard: bundledDashboard(dashboard) } } }
}

/** Runs the CLI as the release binary does. */
export function runRelease(argv: readonly string[], dashboard?: unknown, io?: CliIo): Promise<ExitCode> {
  return main(argv, io, releaseDeps(dashboard))
}
