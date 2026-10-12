/**
 * Hook warnings go to `<home>/logs/hooks.log` (0600): a hook must never block or confuse the agent,
 * so an unreachable bridge is reported there instead of on the agent's stderr.
 */
import { appendFile, chmod } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { ensurePrivateDir, FILE_MODE } from '@agent-peers/core'

export type HookLogger = (line: string) => Promise<void>

/** Lines longer than this are cut: a log line never carries a whole envelope or tool input. */
const MAX_LOG_LINE = 2000

export const hookLogPath = (homeRoot: string): string => join(homeRoot, 'logs', 'hooks.log')

/**
 * Appends timestamped lines to `path`. When the log itself cannot be written, the line goes to
 * `fallback` (stderr), which Claude Code shows only in verbose mode for a hook that exits 0.
 */
export function fileLogger(
  path: string,
  fallback: (line: string) => void,
  now: () => number = Date.now,
): HookLogger {
  return async (line) => {
    const text = `${new Date(now()).toISOString()} ${line.replace(/\s+/g, ' ').slice(0, MAX_LOG_LINE)}\n`
    try {
      await ensurePrivateDir(dirname(path))
      await appendFile(path, text, { mode: FILE_MODE })
      await chmod(path, FILE_MODE)
    } catch (error) {
      fallback(`[agent-peers] ${line} (hook log unavailable: ${String(error)})`)
    }
  }
}
