/**
 * A plain protocol client sitting in the room (no bridge): it records the notifications every room
 * member gets, so tests can assert what peers actually see (`presence.changed`, renames, chat).
 */
import { HubClient, type NotificationMap, SessionHandle } from './deps'
import type { E2eHub, E2eRoom } from './hub'
import { eventually } from './wait'

export type PresenceEvent = NotificationMap['presence.changed']

export interface Watcher {
  readonly presence: readonly PresenceEvent[]
  /** A position in the presence log, to wait only for later events. */
  mark(): number
  /** Waits for a presence change matching `match`, at or after position `after` (default 0). */
  waitPresence(
    what: string,
    match: (event: PresenceEvent) => boolean,
    after?: number,
    timeoutMs?: number,
  ): Promise<PresenceEvent>
  close(): Promise<void>
}

export async function startWatcher(hub: E2eHub, room: E2eRoom, name = 'watcher'): Promise<Watcher> {
  const client = new HubClient({
    bridge: { agent_kind: 'other', agent_version: '1.0.0', adapter: '0.1.0', host: 'watcher-host' },
    heartbeatMs: 60_000,
  })
  const session = new SessionHandle(client, {
    localKey: `${name}-1`,
    card: { agent: { kind: 'other', adapter: '0.1.0' }, host: 'watcher-host' },
  })
  let presence: readonly PresenceEvent[] = []
  session.on('presence.changed', (event) => {
    presence = [...presence, event]
  })
  await client.connect(hub.url, hub.hub.services.members.create(name).token)
  await session.open()
  const code = room.inviteUrl.split('/').at(-1) ?? ''
  await session.join({ invite_code: code, handle: name })
  return {
    get presence() {
      return presence
    },
    mark: () => presence.length,
    waitPresence: (what, match, after = 0, timeoutMs = 15_000) =>
      eventually(`presence: ${what}`, () => presence.slice(after).find(match), { timeoutMs }),
    async close() {
      session.dispose()
      await client.close('test done')
    },
  }
}
