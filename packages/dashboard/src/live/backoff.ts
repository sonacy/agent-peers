/** Reconnect backoff for the event stream (DASHBOARD §7): 1s, 2s, 4s … capped at 30s. */
import { RECONNECT_MAX_MS, RECONNECT_MIN_MS } from '@agent-peers/protocol'

/** Delay before reconnect attempt `attempt` (1-based). */
export function backoffDelay(attempt: number, min = RECONNECT_MIN_MS, max = RECONNECT_MAX_MS): number {
  if (attempt <= 1) return min
  return Math.min(max, min * 2 ** Math.min(attempt - 1, 16))
}
