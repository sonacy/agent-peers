import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { PeersError, UNAUTHORIZED_CLOSE_CODE } from '@agent-peers/protocol'
import { HubClient } from '../src/client/hub-client'
import type { WebSocketLike } from '../src/client/socket'
import type { HubClientOptions, LifecycleEvent } from '../src/client/types'
import { bridge, FakeHub, fail, ok } from './helpers/fake-hub'

let hub: FakeHub
let clients: HubClient[] = []

const makeClient = (overrides: Partial<HubClientOptions> = {}) => {
  const client = new HubClient({
    bridge,
    requestTimeoutMs: 1000,
    reconnect: { initialMs: 10, maxMs: 40, jitter: 0 },
    ...overrides,
  })
  clients.push(client)
  return client
}

const record = (client: HubClient) => {
  const events: LifecycleEvent[] = []
  client.onLifecycle((e) => events.push(e))
  return events
}

const waitState = async (client: HubClient, state: string) => hub.waitFor(() => client.state === state)

beforeEach(() => {
  hub = new FakeHub()
})

afterEach(async () => {
  await Promise.all(clients.map((c) => c.close()))
  clients = []
  hub.stop()
})

describe('HubClient connect', () => {
  it('sends the bearer token and hello, and records the welcome', async () => {
    const client = makeClient()
    const events = record(client)
    const welcome = await client.connect(hub.url, 'tok-1')
    expect(hub.auths).toEqual(['Bearer tok-1'])
    expect(hub.callsOf('hello')[0]?.params).toEqual({ protocol: ['agent-peers/0.3'], bridge })
    expect(welcome.heartbeat_ms).toBe(10_000)
    expect(client.welcome?.min_adapter).toBe('0.1.0')
    expect(client.outdated).toBe(false)
    expect(client.state).toBe('connected')
    expect(events.map((e) => e.type)).toEqual(['connecting', 'connected'])
  })

  it('flags an outdated adapter', async () => {
    hub.minAdapter = '0.3.0'
    const client = makeClient()
    await client.connect(hub.url, 't')
    expect(client.outdated).toBe(true)
  })

  it('rejects version_unsupported and returns to idle', async () => {
    hub.on('hello', () => fail('version_unsupported', 'need 0.4', { supported: ['agent-peers/0.4'] }))
    const client = makeClient()
    const error = await client.connect(hub.url, 't').catch((e: unknown) => e)
    expect(error).toBeInstanceOf(PeersError)
    expect((error as PeersError).code).toBe('version_unsupported')
    expect((error as PeersError).data?.supported).toEqual(['agent-peers/0.4'])
    expect(client.state).toBe('idle')
  })

  it('rejects when the upgrade is refused', async () => {
    hub.rejectUpgrade = true
    const client = makeClient()
    await expect(client.connect(hub.url, 'bad')).rejects.toMatchObject({ code: 'disconnected' })
  })

  it('refuses plain ws:// to public hosts unless insecure', async () => {
    const client = makeClient()
    await expect(client.connect('http://8.8.8.8:7337', 't')).rejects.toMatchObject({
      code: 'insecure_transport',
    })
    expect(() => makeClient().connect(hub.url, 't')).not.toThrow()
  })

  it('cannot connect twice', async () => {
    const client = makeClient()
    await client.connect(hub.url, 't')
    await expect(client.connect(hub.url, 't')).rejects.toMatchObject({ code: 'internal' })
  })
})

describe('HubClient requests', () => {
  it('correlates out-of-order responses', async () => {
    hub.on('room.search', async (p) => {
      await Bun.sleep(p.q === 'slow' ? 40 : 1)
      return ok({
        rooms: [{ room_id: String(p.q), name: String(p.q), owner: 'bob', member_count: 1, my_state: 'none' }],
      })
    })
    const client = makeClient()
    await client.connect(hub.url, 't')
    const [slow, fast] = await Promise.all([
      client.request('room.search', { session_id: 's', q: 'slow' }),
      client.request('room.search', { session_id: 's', q: 'fast' }),
    ])
    expect(slow.rooms[0]?.name).toBe('slow')
    expect(fast.rooms[0]?.name).toBe('fast')
  })

  it('maps protocol and JSON-RPC errors', async () => {
    hub.on('room.join', () => fail('handle_taken'))
    hub.on('msg.send', () => fail('rate_limited', 'slow down', { retry_after_ms: 500 }))
    const client = makeClient()
    await client.connect(hub.url, 't')
    await expect(client.request('room.join', { session_id: 's', room_id: 'r' })).rejects.toMatchObject({
      code: 'handle_taken',
    })
    const limited = await client
      .request('msg.send', { session_id: 's', client_msg_id: 'c', room_id: 'r', kind: 'chat', text: 'x' })
      .catch((e: PeersError) => e)
    expect(limited).toMatchObject({ code: 'rate_limited', retryAfterMs: 500 })
    await expect(client.request('room.list', { session_id: 's' })).rejects.toMatchObject({
      code: 'method_not_found',
    })
  })

  it('validates results', async () => {
    hub.on('room.list', () => ok({ rooms: 'nope' }))
    const client = makeClient()
    await client.connect(hub.url, 't')
    await expect(client.request('room.list', { session_id: 's' })).rejects.toMatchObject({
      code: 'invalid_result',
    })
  })

  it('times out unanswered requests', async () => {
    hub.on('room.list', () => ({ noreply: true }))
    const client = makeClient()
    await client.connect(hub.url, 't')
    await expect(client.request('room.list', { session_id: 's' }, { timeoutMs: 30 })).rejects.toMatchObject({
      code: 'timeout',
    })
    expect(client.state).toBe('connected')
  })

  it('rejects oversized frames locally', async () => {
    const client = makeClient()
    await client.connect(hub.url, 't')
    await expect(
      client.request('room.search', { session_id: 's', q: 'x'.repeat(300_000) }),
    ).rejects.toMatchObject({
      code: 'payload_too_large',
    })
  })

  it('rejects requests before connect and after close', async () => {
    const client = makeClient()
    await expect(client.request('room.list', { session_id: 's' })).rejects.toMatchObject({
      code: 'not_connected',
    })
    await client.close()
    await expect(client.request('room.list', { session_id: 's' })).rejects.toMatchObject({ code: 'closed' })
  })

  it('answers hub-initiated requests with -32601 and reports bad frames', async () => {
    const client = makeClient()
    const events = record(client)
    await client.connect(hub.url, 't')
    hub.sendRaw(JSON.stringify({ jsonrpc: '2.0', id: 'x1', method: 'weird' }))
    hub.sendRaw('not json')
    hub.sendRaw(JSON.stringify({ jsonrpc: '2.0', id: 999, result: {} }))
    await hub.waitFor(() => hub.responses.length === 1)
    expect(hub.responses[0]).toMatchObject({ id: 'x1', error: { code: -32601 } })
    await hub.waitFor(() => events.filter((e) => e.type === 'error').length === 2)
  })
})

describe('HubClient notifications', () => {
  it('delivers validated notifications and supports unsubscribe', async () => {
    const client = makeClient()
    const events = record(client)
    await client.connect(hub.url, 't')
    const seen: string[] = []
    const off = client.on('replay.done', (n) => seen.push(`${n.room_id}:${n.head_seq}`))
    hub.notify('replay.done', { session_id: 's', room_id: 'r', head_seq: 4 })
    hub.notify('future.thing', { session_id: 's' })
    hub.notify('replay.done', { session_id: 's', room_id: 'r' })
    await hub.waitFor(() => seen.length === 1 && events.some((e) => e.type === 'error'))
    off()
    hub.notify('replay.done', { session_id: 's', room_id: 'r', head_seq: 5 })
    await Bun.sleep(20)
    expect(seen).toEqual(['r:4'])
  })
})

describe('HubClient heartbeat and reconnect', () => {
  it('pings after heartbeat_ms without sending', async () => {
    hub.heartbeatMs = 30
    const client = makeClient()
    await client.connect(hub.url, 't')
    await hub.waitFor(() => hub.callsOf('ping').length >= 2)
    expect(client.state).toBe('connected')
  })

  it('treats a silent hub as dead and reconnects', async () => {
    hub.heartbeatMs = 30
    const client = makeClient()
    const events = record(client)
    await client.connect(hub.url, 't')
    hub.mute = true
    await hub.waitFor(() => events.some((e) => e.type === 'disconnected'))
    expect(events.find((e) => e.type === 'disconnected')).toMatchObject({ reason: 'heartbeat timeout' })
    hub.mute = false
    await hub.waitFor(() => events.some((e) => e.type === 'connected' && e.reconnected))
    expect(hub.callsOf('hello').length).toBeGreaterThanOrEqual(2)
  })

  it('reconnects with backoff after the hub drops the socket', async () => {
    const client = makeClient()
    const events = record(client)
    await client.connect(hub.url, 't')
    hub.on('hello', () => fail('internal', 'not yet'))
    hub.dropAll()
    await hub.waitFor(() => events.filter((e) => e.type === 'reconnecting').length >= 3)
    const delays = events.flatMap((e) => (e.type === 'reconnecting' ? [e.delayMs] : []))
    expect(delays.slice(0, 3)).toEqual([10, 20, 40])
    hub.handlers.delete('hello')
    await waitState(client, 'connected')
    expect(events.at(-1)).toMatchObject({ type: 'connected', reconnected: true })
  })

  it('stops reconnecting on a fatal handshake error', async () => {
    const client = makeClient()
    const events = record(client)
    await client.connect(hub.url, 't')
    hub.on('hello', () => fail('version_unsupported'))
    hub.dropAll()
    await waitState(client, 'closed')
    expect(events.at(-1)).toMatchObject({ type: 'closed', error: { code: 'version_unsupported' } })
  })

  it('treats a refused token as fatal on connect', async () => {
    hub.refuseToken = true
    const client = makeClient()
    await expect(client.connect(hub.url, 'revoked')).rejects.toMatchObject({ code: 'unauthorized' })
    expect(client.state).toBe('idle')
  })

  it('maps a 4401 close that lands before the handshake starts to unauthorized', async () => {
    const instant = (code: number) => (): WebSocketLike => {
      const listeners = new Map<string, ((event: never) => void)[]>()
      const fire = (type: string, event: unknown) => {
        for (const listener of listeners.get(type) ?? []) listener(event as never)
      }
      setTimeout(() => {
        fire('open', {})
        fire('close', { code, reason: 'refused' })
      }, 1)
      return {
        send: () => undefined,
        close: () => undefined,
        addEventListener: (type: string, listener: (event: never) => void) => {
          listeners.set(type, [...(listeners.get(type) ?? []), listener])
        },
      } as WebSocketLike
    }
    const refused = makeClient({ webSocketFactory: instant(UNAUTHORIZED_CLOSE_CODE) })
    await expect(refused.connect(hub.url, 't')).rejects.toMatchObject({ code: 'unauthorized' })
    const dropped = makeClient({ webSocketFactory: instant(1006) })
    await expect(dropped.connect(hub.url, 't')).rejects.toMatchObject({ code: 'disconnected' })
  })

  it('stops reconnecting when the token is refused on reconnect', async () => {
    const client = makeClient()
    const events = record(client)
    await client.connect(hub.url, 't')
    hub.refuseToken = true
    hub.dropAll()
    await waitState(client, 'closed')
    expect(events.at(-1)).toMatchObject({ type: 'closed', error: { code: 'unauthorized' } })
    const connections = hub.connections
    await Bun.sleep(60)
    expect(hub.connections).toBe(connections)
  })

  it('fails a queued send with timeout while the hub stays unreachable', async () => {
    const client = makeClient({ requestTimeoutMs: 80 })
    await client.connect(hub.url, 't')
    hub.on('hello', () => fail('internal', 'down'))
    hub.dropAll()
    await waitState(client, 'reconnecting')
    const params = { session_id: 's', client_msg_id: 'C', room_id: 'r', kind: 'chat', text: 'x' } as const
    await expect(client.request('msg.send', params)).rejects.toMatchObject({ code: 'timeout' })
  })

  it('closes for good when the hub revokes the token on a live connection', async () => {
    hub.on('msg.send', () => ({ noreply: true }))
    const client = makeClient()
    const events = record(client)
    await client.connect(hub.url, 't')
    const params = { session_id: 's', client_msg_id: 'C', room_id: 'r', kind: 'chat', text: 'x' } as const
    const pending = client.request('msg.send', params)
    await hub.waitFor(() => hub.callsOf('msg.send').length === 1)
    hub.dropAll(UNAUTHORIZED_CLOSE_CODE)
    await expect(pending).rejects.toMatchObject({ code: 'unauthorized' })
    await waitState(client, 'closed')
    expect(events.map((e) => e.type).slice(-2)).toEqual(['disconnected', 'closed'])
    expect(events.at(-1)).toMatchObject({ error: { code: 'unauthorized' } })
    await Bun.sleep(40)
    expect(hub.connections).toBe(1)
  })

  it('rejects in-flight non-idempotent requests with disconnected', async () => {
    hub.on('room.list', () => ({ drop: true }))
    const client = makeClient()
    await client.connect(hub.url, 't')
    await expect(client.request('room.list', { session_id: 's' })).rejects.toMatchObject({
      code: 'disconnected',
    })
  })

  it('retries unanswered sends with the same client_msg_id', async () => {
    let attempts = 0
    hub.on('msg.send', () => {
      attempts += 1
      return attempts === 1 ? { drop: true } : ok({ id: 'm1', seq: 7 })
    })
    const client = makeClient()
    await client.connect(hub.url, 't')
    const params = { session_id: 's', client_msg_id: 'CMID', room_id: 'r', kind: 'chat', text: 'hi' } as const
    const result = await client.request('msg.send', params)
    expect(result).toMatchObject({ id: 'm1', seq: 7 })
    const sends = hub.callsOf('msg.send')
    expect(sends.map((c) => c.params.client_msg_id)).toEqual(['CMID', 'CMID'])
    expect(sends[0]?.conn).not.toBe(sends[1]?.conn)
  })

  it('queues idempotent sends made while reconnecting and fails others fast', async () => {
    hub.on('msg.progress', () => ok({ id: 'p', seq: 1 }))
    const client = makeClient({ reconnect: { initialMs: 60, maxMs: 60, jitter: 0 } })
    await client.connect(hub.url, 't')
    hub.dropAll()
    await waitState(client, 'reconnecting')
    const queued = client.request('msg.progress', {
      session_id: 's',
      client_msg_id: 'c',
      ask_id: 'a',
      text: 'x',
    })
    await expect(client.request('room.list', { session_id: 's' })).rejects.toMatchObject({
      code: 'not_connected',
    })
    expect(await queued).toMatchObject({ id: 'p' })
  })

  it('without reconnect, a drop leaves the client idle', async () => {
    const client = makeClient({ reconnect: false })
    await client.connect(hub.url, 't')
    hub.dropAll()
    await waitState(client, 'idle')
  })

  it('reports resync hook failures without failing the connection', async () => {
    const client = makeClient()
    const events = record(client)
    client.onResync(async () => {
      throw new Error('boom')
    })
    const off = client.onResync(async () => undefined)
    off()
    await client.connect(hub.url, 't')
    expect(events.find((e) => e.type === 'error')).toMatchObject({ error: { code: 'internal' } })
  })
})

describe('HubClient close', () => {
  it('sends bye and rejects outstanding requests', async () => {
    hub.on('room.list', () => ({ noreply: true }))
    const client = makeClient()
    const events = record(client)
    await client.connect(hub.url, 't')
    const pending = client.request('room.list', { session_id: 's' })
    await hub.waitFor(() => hub.callsOf('room.list').length === 1)
    await client.close()
    await expect(pending).rejects.toMatchObject({ code: 'closed' })
    await hub.waitFor(() => hub.callsOf('bye').length === 1)
    expect(hub.callsOf('bye')[0]?.id).toBeUndefined()
    expect(events.at(-1)).toMatchObject({ type: 'closed' })
    await client.close()
  })

  it('close while reconnecting cancels the retry and rejects queued sends', async () => {
    const client = makeClient({ reconnect: { initialMs: 500, maxMs: 500, jitter: 0 } })
    await client.connect(hub.url, 't')
    hub.dropAll()
    await waitState(client, 'reconnecting')
    const queued = client.request('msg.send', {
      session_id: 's',
      client_msg_id: 'c',
      room_id: 'r',
      kind: 'chat',
      text: 'x',
    })
    await client.close()
    await expect(queued).rejects.toMatchObject({ code: 'closed' })
    expect(hub.connections).toBe(1)
  })
})
