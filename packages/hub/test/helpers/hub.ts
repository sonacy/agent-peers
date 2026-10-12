/** Starts a real hub on port 0 with an in-memory database and a fake clock. */

import { silentLogger } from '../../src/config'
import { type CreateHubOptions, createHub, type Hub, type StartInfo } from '../../src/hub'
import { FakeClock } from './fake-clock'
import { TestClient } from './ws-client'

export interface RunningHub {
  readonly hub: Hub
  readonly info: StartInfo
  readonly clock: FakeClock
  readonly wsUrl: string
  member(name: string): string
  client(token: string, adapter?: string): Promise<TestClient>
  stop(): Promise<void>
}

export async function startHub(options: CreateHubOptions = {}): Promise<RunningHub> {
  const clock = new FakeClock()
  const hub = createHub({
    publicBind: '127.0.0.1',
    publicPort: 0,
    adminPort: 0,
    logger: silentLogger,
    clock,
    ...options,
  })
  const info = await hub.start()
  const clients: TestClient[] = []
  return {
    hub,
    info,
    clock,
    wsUrl: `ws://127.0.0.1:${info.publicPort}/v0/ws`,
    member: (name) => hub.services.members.create(name).token,
    async client(token, adapter) {
      const c = await TestClient.connect(`ws://127.0.0.1:${info.publicPort}/v0/ws`, token)
      clients.push(c)
      await c.hello(adapter)
      return c
    },
    async stop() {
      for (const c of clients) c.close()
      await hub.stop()
    },
  }
}
