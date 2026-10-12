/** Best-effort browser opening for `peers_dashboard`; the tool always prints the link as well. */

export function browserCommand(url: string, platform: NodeJS.Platform = process.platform): readonly string[] {
  if (platform === 'darwin') return ['open', url]
  if (platform === 'win32') return ['cmd', '/c', 'start', '', url]
  return ['xdg-open', url]
}

/** Starts a command and resolves with its exit code. */
export type Spawner = (cmd: readonly string[]) => Promise<number>

/** Runs a command detached from our stdio (stdout is the MCP channel). */
export const spawnQuiet: Spawner = (cmd) =>
  Bun.spawn([...cmd], { stdin: 'ignore', stdout: 'ignore', stderr: 'ignore' }).exited

export async function openInBrowser(url: string, spawn: Spawner = spawnQuiet): Promise<boolean> {
  if (!/^https?:\/\//.test(url)) return false
  try {
    return (await spawn(browserCommand(url))) === 0
  } catch {
    return false
  }
}
