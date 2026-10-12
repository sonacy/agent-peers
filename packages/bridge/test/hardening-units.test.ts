import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isPeersError } from '@agent-peers/protocol'
import { assertRedeemTransport, type FetchLike, redeemInvite } from '../src/hub/invite'
import { bunRunner } from '../src/injectors/codex/process'
import { threadIdOf, turnIdOf } from '../src/mcp/server'

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'apb-hard-'))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

const code = async (promise: Promise<unknown>) =>
  promise.then(
    () => 'resolved',
    (error: unknown) => (isPeersError(error) ? error.code : String(error)),
  )

describe('invite redemption transport', () => {
  const ok: FetchLike = async () =>
    new Response(JSON.stringify({ member_token: 't', member: { name: 'm' }, grant: { room_id: 'r' } }), {
      status: 201,
      headers: { 'content-type': 'application/json' },
    })

  it('refuses plain http to public hosts unless insecure', async () => {
    expect(await code(redeemInvite(ok, 'http://hub.example.com', 'C', 'm'))).toBe('insecure_transport')
    expect(await code(redeemInvite(ok, 'http://hub.example.com', 'C', 'm', { insecure: true }))).toBe(
      'resolved',
    )
    expect(await code(redeemInvite(ok, 'http://192.168.1.5:7337', 'C', 'm'))).toBe('resolved')
    expect(await code(redeemInvite(ok, 'https://hub.example.com', 'C', 'm'))).toBe('resolved')
    expect(() => assertRedeemTransport('http://100.100.1.1', false)).not.toThrow()
  })

  it('never follows a redirect with the invite code', async () => {
    let init: RequestInit | undefined
    const redirecting: FetchLike = async (_url, given) => {
      init = given
      return new Response(null, { status: 307, headers: { location: 'https://evil.example/steal' } })
    }
    expect(await code(redeemInvite(redirecting, 'https://hub.example.com', 'C', 'm'))).toBe('invite_invalid')
    expect(init?.redirect).toBe('error')
  })
})

describe('bunRunner', () => {
  it('kills a child that ignores SIGTERM and does not wait on pipes held by a grandchild', async () => {
    const script = join(dir, 'stubborn.sh')
    await mkdir(dir, { recursive: true })
    await writeFile(script, "#!/bin/sh\ntrap '' TERM\n(sleep 5) &\nsleep 5\n")
    await chmod(script, 0o755)
    const started = Date.now()
    const result = await bunRunner([script], {
      env: { PATH: process.env.PATH },
      timeoutMs: 100,
      killGraceMs: 100,
    })
    expect(result.timedOut).toBe(true)
    expect(result.exitCode).toBeNull()
    expect(Date.now() - started).toBeLessThan(3000)
  })
})

describe('Codex turn metadata', () => {
  it('reads thread and turn ids from object or JSON-text metadata', () => {
    const meta = { 'x-codex-turn-metadata': { thread_id: 'th', turn_id: 'tu' } }
    expect(threadIdOf(meta)).toBe('th')
    expect(turnIdOf(meta)).toBe('tu')
    const text = { 'x-codex-turn-metadata': JSON.stringify({ thread_id: 'a', turn_id: 'b' }) }
    expect(turnIdOf(text)).toBe('b')
    expect(turnIdOf({ 'x-codex-turn-metadata': '{bad' })).toBeUndefined()
    expect(turnIdOf({ 'x-codex-turn-metadata': { turn_id: '' } })).toBeUndefined()
    expect(turnIdOf(undefined)).toBeUndefined()
  })
})
