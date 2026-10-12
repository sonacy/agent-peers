/** Repository paths the e2e tests run and read. */
import { join, resolve } from 'node:path'

export const REPO_ROOT = resolve(import.meta.dir, '../../..')
/** The `agent-peers` CLI entry, run from source with `bun run`. */
export const BIN_PATH = join(REPO_ROOT, 'packages/cli/src/bin.ts')
export const HOOK_FIXTURES = join(REPO_ROOT, 'test/fixtures/hooks/claude-code')
