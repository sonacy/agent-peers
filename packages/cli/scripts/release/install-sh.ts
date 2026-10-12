/**
 * `scripts/install.sh` is rendered from the hub's installer template (packages/hub install-script.ts),
 * so the release asset and the hub's pinned `/install.sh` never drift apart.
 */
import { chmod, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { renderReleaseInstallScript } from '@agent-peers/hub'

export const INSTALL_SH = join('scripts', 'install.sh')

export interface InstallShResult {
  readonly code: number
  readonly message: string
}

/** Writes (or with `check`, verifies) `<repoRoot>/scripts/install.sh`. */
export async function runInstallSh(repoRoot: string, check: boolean): Promise<InstallShResult> {
  const text = renderReleaseInstallScript()
  const target = join(repoRoot, INSTALL_SH)
  const current = await readFile(target, 'utf8').catch(() => undefined)
  if (current === text) return { code: 0, message: `${INSTALL_SH}: up to date` }
  if (check) return { code: 1, message: `${INSTALL_SH}: stale (run bun run release:install-sh)` }
  await Bun.write(target, text)
  await chmod(target, 0o755)
  return { code: 0, message: `wrote ${INSTALL_SH}` }
}
