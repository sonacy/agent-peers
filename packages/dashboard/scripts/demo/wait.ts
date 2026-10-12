/**
 * `bye` is a notification: `client.close()` resolves before the hub has marked the sessions offline.
 * The seed waits for that, so offline times land at the intended (demo clock) moment.
 */
import type { Hub } from '@agent-peers/hub'

export const WAIT_TIMEOUT_MS = 5000
const POLL_MS = 5

export async function waitForOffline(
  hub: Hub,
  sessionIds: readonly string[],
  timeoutMs: number = WAIT_TIMEOUT_MS,
): Promise<void> {
  const { sessions } = hub.services.deps.repos
  const offline = (id: string): boolean => sessions.byId(id)?.connection === 'offline'
  const deadline = Date.now() + timeoutMs
  while (!sessionIds.every(offline)) {
    if (Date.now() > deadline) throw new Error(`demo: sessions still online after ${timeoutMs} ms`)
    await Bun.sleep(POLL_MS)
  }
}
