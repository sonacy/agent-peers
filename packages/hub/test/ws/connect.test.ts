import { afterEach, describe, expect, it } from 'bun:test'
import { MAX_FRAME_BYTES, parseResult, UNAUTHORIZED_CLOSE_CODE } from '@agent-peers/protocol'
import { type RunningHub, startHub } from '../helpers/hub'
import { RpcFailure, TestClient } from '../helpers/ws-client'

let running: RunningHub | undefined

afterEach(async () => {
  await running?.stop()
  running = undefined
})

async function failure(promise: Promise<unknown>): Promise<RpcFailure> {
  try {
    await promise
  } catch (error) {
    if (error instanceof RpcFailure) return error
    throw error
  }
  throw new Error('expected an RPC error')
}

describe('ws connect and framing', () => {
  it('requires a websocket upgrade and a valid member token', async () => {
    running = await startHub()
    const base = `http://127.0.0.1:${running.info.publicPort}`
    expect((await fetch(`${base}/v0/ws`)).status).toBe(426)
    const res = await fetch(`${base}/v0/ws`, { headers: { upgrade: 'websocket' } })
    expect(res.status).toBe(400)
    expect((await fetch(`${base}/elsewhere`)).status).toBe(404)
  })

  it('answers hello on a socket with a bad or missing token with unauthorized, then closes it (4401)', async () => {
    running = await startHub()
    const Ctor = WebSocket as unknown as new (u: string, o: { headers: Record<string, string> }) => WebSocket
    const attempts: Record<string, string>[] = [{ Authorization: 'Bearer apm_badbadbad' }, {}]
    for (const headers of attempts) {
      const ws = new Ctor(running.wsUrl, { headers })
      const reply = new Promise<string>((resolve) =>
        ws.addEventListener('message', (e) => resolve(String(e.data))),
      )
      const closed = new Promise<CloseEvent>((resolve) => ws.addEventListener('close', resolve))
      await new Promise((resolve) => ws.addEventListener('open', resolve))
      ws.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'hello', params: {} }))
      expect(JSON.parse(await reply).error.data.code).toBe('unauthorized')
      const event = await closed
      expect(event.code).toBe(UNAUTHORIZED_CLOSE_CODE)
      expect(event.reason).toBe('unauthorized')
    }
    expect(running.hub.registry.connectionCount).toBe(0)
  })

  it('closes a refused socket that sends nothing after two heartbeats', async () => {
    running = await startHub()
    const Ctor = WebSocket as unknown as new (u: string, o: { headers: Record<string, string> }) => WebSocket
    const ws = new Ctor(running.wsUrl, { headers: { Authorization: 'Bearer apm_nope' } })
    const closed = new Promise<CloseEvent>((resolve) => ws.addEventListener('close', resolve))
    await new Promise((resolve) => ws.addEventListener('open', resolve))
    await Bun.sleep(10)
    running.clock.advance(30_000)
    expect((await closed).code).toBe(UNAUTHORIZED_CLOSE_CODE)
  })

  it('says hello and answers ping', async () => {
    running = await startHub({ minAdapter: '0.2.0' })
    const client = await TestClient.connect(running.wsUrl, running.member('alice'))
    const welcome = parseResult('hello', await client.hello('0.3.0'))
    expect(welcome).toMatchObject({
      protocol: 'agent-peers/0.3',
      heartbeat_ms: 15000,
      grace_ms: 90000,
      min_adapter: '0.2.0',
    })
    const pong = parseResult('ping', await client.request('ping'))
    expect(pong.server_time).toBe(running.clock.now())
  })

  it('needs hello before anything else', async () => {
    running = await startHub()
    const client = await TestClient.connect(running.wsUrl, running.member('alice'))
    const error = await failure(client.request('ping'))
    expect(error.code).toBe('invalid_request')
  })

  it('refuses incompatible protocols and closes the socket', async () => {
    running = await startHub()
    const client = await TestClient.connect(running.wsUrl, running.member('alice'))
    const error = await failure(client.hello('0.3.0', ['agent-peers/9.9']))
    expect(error.code).toBe('version_unsupported')
    expect(error.error.data?.supported).toEqual(['agent-peers/0.3'])
    expect((await client.closed).code).toBe(4002)
  })

  it('marks sessions of outdated adapters', async () => {
    running = await startHub({ minAdapter: '0.5.0' })
    const client = await running.client(running.member('alice'), '0.4.9')
    const opened = await client.open('k1')
    expect(running.hub.services.cards.byId(opened.session_id)?.outdated).toBe(true)
  })

  it('maps bad frames to JSON-RPC errors', async () => {
    running = await startHub()
    const client = await running.client(running.member('alice'))
    expect((await failure(client.request('nope.method'))).error.code).toBe(-32601)
    expect((await failure(client.request('session.open', { local_key: '' }))).code).toBe('invalid_params')
    expect((await failure(client.request('room.create', { session_id: 'x', name: 'Bad Name' }))).code).toBe(
      'invalid_name',
    )
    client.sendRaw('{not json')
    const parse = await waitError(client)
    expect(parse.error?.data?.code).toBe('parse_error')
    client.sendRaw('x'.repeat(MAX_FRAME_BYTES + 10))
    const big = await waitError(client, 'payload_too_large')
    expect(big.error?.data?.code).toBe('payload_too_large')
    client.sendRaw('[]')
    expect((await waitError(client, 'invalid_request')).error?.data?.code).toBe('invalid_request')
  })

  it('checks that session_id belongs to the connection', async () => {
    running = await startHub()
    const token = running.member('alice')
    const one = await running.client(token)
    const two = await running.client(token)
    const opened = await one.open('k1')
    const error = await failure(two.request('room.list', { session_id: opened.session_id }))
    expect(error.code).toBe('unknown_session')
    expect(
      parseResult('room.list', await one.request('room.list', { session_id: opened.session_id })).rooms,
    ).toEqual([])
  })

  it('ignores unknown notifications and stray responses', async () => {
    running = await startHub()
    const client = await running.client(running.member('alice'))
    client.notify('something.new', {})
    client.sendRaw(JSON.stringify({ jsonrpc: '2.0', id: 99, result: {} }))
    expect(parseResult('ping', await client.request('ping')).server_time).toBeGreaterThan(0)
  })
})

async function waitError(client: TestClient, code?: string) {
  const deadline = Date.now() + 2000
  while (Date.now() < deadline) {
    const found = client.frames.find(
      (f) => f.id === null && f.error && (code === undefined || f.error.data?.code === code),
    )
    if (found) {
      client.frames.splice(client.frames.indexOf(found), 1)
      return found
    }
    await Bun.sleep(5)
  }
  throw new Error(`no error frame ${code ?? ''}`)
}
