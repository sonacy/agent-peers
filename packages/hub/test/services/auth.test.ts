import { describe, expect, it } from 'bun:test'
import { isPeersError } from '@agent-peers/protocol'
import { makeHarness } from '../helpers/services'

const code = (fn: () => unknown) => {
  try {
    fn()
  } catch (error) {
    return isPeersError(error) ? error.code : 'other'
  }
  return 'ok'
}

describe('members and auth', () => {
  it('creates members with suffixes and authenticates tokens', () => {
    const h = makeHarness()
    const first = h.services.members.create('alice')
    const second = h.services.members.create('alice')
    expect(second.member.name).toBe('alice-2')
    expect(second.renamed).toBe(true)
    expect(h.services.members.authenticate(first.token)?.id).toBe(first.member.id)
    expect(h.services.members.authenticate('apm_wrong')).toBeUndefined()
    expect(code(() => h.services.members.create('Not Valid'))).toBe('invalid_name')
    expect(h.services.members.revokeTokens(first.member.id)).toBe(1)
    expect(h.services.members.authenticate(first.token)).toBeUndefined()
    const extra = h.services.members.issueToken(first.member.id)
    expect(h.services.members.authenticate(extra)?.name).toBe('alice')
  })

  it('registers only on open hubs and never suffixes', () => {
    expect(code(() => makeHarness().services.members.register('alice'))).toBe('forbidden')
    const h = makeHarness({ registration: 'open' })
    expect(h.services.members.register('alice').member.name).toBe('alice')
    expect(code(() => h.services.members.register('alice'))).toBe('invalid_name')
  })

  it('redeems invites for new and existing members', () => {
    const h = makeHarness()
    const alice = h.member('alice')
    const created = h.services.rooms.create(h.as(alice.id), { name: 'team' })
    const inviteCode = created.rendered?.invite_url.split('/').at(-1) ?? ''
    const redeemed = h.services.members.redeemAsNew(inviteCode, 'alice')
    expect(redeemed.member.name).toBe('alice-2')
    expect(redeemed.grant).toEqual({ room_id: created.room_id, member: 'alice-2', role: 'member' })
    expect(code(() => h.services.members.redeemAsNew('AAAAAAAAAAAAAAAA', 'zed'))).toBe('invite_invalid')
    expect(h.services.deps.repos.members.byName('zed')).toBeUndefined()
    const bob = h.member('bob')
    expect(h.services.members.redeemFor(bob.id, inviteCode).role).toBe('member')
    expect(h.services.members.redeemFor(bob.id, inviteCode).role).toBe('member')
    expect(code(() => h.services.members.redeemFor('nope', inviteCode))).toBe('unauthorized')
  })

  it('issues one-time 5-minute dashboard login codes and 7-day web sessions', () => {
    const h = makeHarness()
    const alice = h.member('alice')
    const s = h.open(alice.id, 'a1')
    const link = h.services.auth.createLogin(s)
    expect(link.url).toBe(`http://127.0.0.1:7337/app/login?c=${link.code}`)
    const web = h.services.auth.consumeLogin(link.code)
    expect(web.member_id).toBe(alice.id)
    expect(code(() => h.services.auth.consumeLogin(link.code))).toBe('unauthorized')
    expect(h.services.auth.webSession(web.token)).toBe(alice.id)
    h.services.auth.logout(web.token)
    expect(h.services.auth.webSession(web.token)).toBeUndefined()
    const late = h.services.auth.createLogin(s)
    h.clock.advance(5 * 60_000)
    expect(code(() => h.services.auth.consumeLogin(late.code))).toBe('unauthorized')
    const session = h.services.auth.openWebSession(alice.id)
    h.clock.advance(7 * 24 * 3600_000)
    expect(h.services.auth.webSession(session.token)).toBeUndefined()
    h.services.deps.runtime.publicUrl = undefined
    expect(code(() => h.services.auth.createLogin(s))).toBe('forbidden')
  })

  it('verifies and rotates the hashed admin token', () => {
    const h = makeHarness()
    expect(h.services.auth.verifyAdmin('anything')).toBe(false)
    const token = h.services.auth.rotateAdmin()
    expect(h.services.auth.verifyAdmin(token)).toBe(true)
    const next = h.services.auth.rotateAdmin()
    expect(h.services.auth.verifyAdmin(token)).toBe(false)
    expect(h.services.auth.verifyAdmin(next)).toBe(true)
    expect(h.services.deps.repos.admin.get()?.token_hash).not.toContain(next)
  })
})
