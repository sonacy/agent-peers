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

const codeOf = (url: string | undefined) => url?.split('/').at(-1) ?? ''

function setup() {
  const h = makeHarness()
  const alice = h.member('alice')
  const created = h.services.rooms.create(h.as(alice.id), { name: 'team', display_name: 'Payments team' })
  return { h, alice, room: created.room_id, first: codeOf(created.rendered?.invite_url) }
}

describe('invites (§8, §10.1)', () => {
  it('rotates: the old code stops working immediately', () => {
    const { h, alice, room, first } = setup()
    const rotated = h.services.invites.rotate(h.as(alice.id), room)
    expect(codeOf(rotated.invite_url)).not.toBe(first)
    expect(rotated.join_prompt).toContain('Payments team')
    expect(code(() => h.services.invites.resolve(first))).toBe('invite_invalid')
    expect(h.services.invites.resolve(codeOf(rotated.invite_url)).room.id).toBe(room)
  })

  it('closes: redeem gets invite_closed; reopen mints a fresh code', () => {
    const { h, alice, room, first } = setup()
    expect(h.services.invites.close(h.as(alice.id), room)).toEqual({})
    expect(code(() => h.services.invites.resolve(first))).toBe('invite_closed')
    expect(h.services.invites.view(room)?.state).toBe('closed')
    const reopened = h.services.invites.reopen(h.as(alice.id), room)
    expect(codeOf(reopened.invite_url)).not.toBe(first)
    expect(h.services.invites.view(room)?.state).toBe('active')
    expect(h.services.invites.reopen(h.as(alice.id), room).invite_url).toBe(reopened.invite_url)
  })

  it('is owner only', () => {
    const { h, room } = setup()
    const bob = h.member('bob')
    h.grant(room, bob.id)
    expect(code(() => h.services.invites.rotate(h.as(bob.id), room))).toBe('forbidden')
    expect(code(() => h.services.invites.createFor(h.as(bob.id), room))).toBe('forbidden')
  })

  it('renders invite.create with lang and suggested handle, reopening a closed invite', () => {
    const { h, alice, room } = setup()
    h.services.invites.close(h.as(alice.id), room)
    const rendered = h.services.invites.createFor(h.as(alice.id), room, {
      lang: 'zh',
      suggestedHandle: 'api',
    })
    expect(rendered.join_prompt).toContain('加入我的 agent-peers 房间')
    expect(rendered.join_command).toContain("--handle 'api'")
    expect(rendered.expires_at).toBeNull()
  })

  it('shows the masked code and the loopback warning to owners', () => {
    const { h, room, first } = setup()
    const view = h.services.invites.view(room)
    expect(view?.code_masked).toBe(`inv_••••••••${first.slice(-4)}`)
    expect(view?.loopback).toBe(true)
    expect(h.services.invites.promptFor(room)).toContain(first)
    h.services.deps.runtime.publicUrl = 'https://hub.example.com'
    expect(h.services.invites.view(room)?.loopback).toBe(false)
    h.services.deps.runtime.publicUrl = undefined
    expect(h.services.invites.promptFor(room)).toBeNull()
    expect(code(() => h.services.invites.createFor({ kind: 'admin' }, room))).toBe('forbidden')
    expect(h.services.invites.rotate({ kind: 'admin' }, room)).toEqual({})
  })

  it('previews a code publicly', () => {
    const { h, first } = setup()
    const preview = h.services.invites.preview(first)
    expect(preview.room.name).toBe('team')
    expect(preview.inviter).toBe('alice')
    expect(code(() => h.services.invites.preview('AAAAAAAAAAAAAAAA'))).toBe('invite_invalid')
  })

  it('refuses to render when the invite secret changed', () => {
    const { h, room } = setup()
    h.services.deps.runtime.inviteSecret = 'rotated-secret'
    expect(h.services.invites.promptFor(room)).toBeNull()
    expect(code(() => h.services.invites.createFor({ kind: 'admin' }, room))).toBe('invite_invalid')
  })

  it('reports a dissolved room for its old code', () => {
    const { h, alice, room, first } = setup()
    h.services.membership.dissolve(h.as(alice.id), room)
    expect(code(() => h.services.invites.resolve(first))).toBe('room_not_found')
    expect(h.services.invites.view('nope')).toBeNull()
  })
})
