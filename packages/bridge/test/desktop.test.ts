import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { type BridgeHarness, eventually, type Peer, startWorld, type World } from './helpers/world'

let world: World

beforeEach(async () => {
  world = await startWorld()
})
afterEach(async () => {
  await world.stop()
})

/** Alice owns room "team" as @home; the desktop bridge joins it through the HTTP redeem path. */
async function joinedDesktop(): Promise<{ alice: Peer; desk: BridgeHarness; roomId: string }> {
  const alice = await world.peer('alice')
  const room = await world.room(alice, 'team', 'home')
  const desk = await world.bridge('claude-desktop')
  const joined = await desk.call('peers_join', { invite: room.inviteUrl, handle: 'work', remember: 'none' })
  expect(joined.isError).toBe(false)
  return { alice, desk, roomId: room.roomId }
}

describe('claude-desktop bridge', () => {
  it('registers every canonical tool and the desktop instructions', async () => {
    const desk = await world.bridge('claude-desktop')
    const tools = await desk.tools()
    expect(tools).toContain('peers_inbox')
    // Every peers_* tool; peers_hook is listed only where hooks call it as an MCP tool (Codex).
    expect(tools).toHaveLength(15)
    expect(tools).not.toContain('peers_hook')
    expect(desk.client.getInstructions()).toContain('call peers_inbox once')
    expect(desk.bridge.verdict?.ok).toBe(true)
  })

  it('tells the user to join first when there is no token yet, then joins', async () => {
    const alice = await world.peer('alice')
    const room = await world.room(alice, 'team', 'home')
    const desk = await world.bridge('claude-desktop')
    const who = await desk.call('peers_who')
    expect(who.isError).toBe(true)
    expect(who.text).toContain('unauthorized')
    const byCode = await desk.call('peers_join', { invite: room.code })
    expect(byCode.text).toContain('unauthorized')
    const joined = await desk.call('peers_join', { invite: room.inviteUrl, member: 'zed' })
    expect(joined.text).toContain('joined room "team"')
    const again = await desk.call('peers_join', { invite: 'team' })
    expect(again.text).toContain('joined room "team"')
  })

  it('keeps other members’ asks and replies out of this inbox', async () => {
    const { alice, desk, roomId } = await joinedDesktop()
    const room = (
      await alice.client.request('invite.create', { session_id: alice.session.sessionId, room_id: roomId })
    ).invite_url
    const bob = await world.peer('bob')
    await bob.session.join({ invite_code: room.split('/').at(-1) ?? '', handle: 'bob' })
    await alice.session.ask({ room_id: roomId, to: 'bob', text: 'only for bob' })
    await alice.session.send({ room_id: roomId, text: 'for everyone' })
    const inbox = await eventually(async () => {
      const out = await desk.call('peers_inbox')
      return out.text.includes('for everyone') ? out : undefined
    })
    expect(inbox.text).not.toContain('only for bob')
  })

  it('redeems an invite over HTTP, stores the token and joins with the handle', async () => {
    const { desk, roomId } = await joinedDesktop()
    const creds = await desk.home.readCredentials()
    expect(Object.keys(creds.hubs)).toEqual([world.url])
    const who = await desk.call('peers_who')
    expect(who.text).toContain('@work (you)')
    expect(who.text).toContain('@home')
    expect(who.text).toContain('room "team"')
    expect(desk.bridge.runtime?.registry.list()[0]?.rooms[0]?.room_id).toBe(roomId)
  })

  it('answers an ask inline when the reply arrives in time', async () => {
    const { alice, desk } = await joinedDesktop()
    alice.notes
      .waitFor('msg.new', (n) => n.message.kind === 'ask')
      .then(async (n) => {
        await alice.session.claim(n.message.id)
        await alice.session.progress({ ask_id: n.message.id, text: 'looking' })
        await alice.session.reply({ ask_id: n.message.id, text: 'exponential, 3 tries' })
      })
    const asked = await desk.call('peers_ask', {
      target: '@home',
      question: 'retry policy?',
      wait_seconds: 3,
    })
    expect(asked.isError).toBe(false)
    expect(asked.text).toContain('[agent-peers] REPLY from @home')
    expect(asked.text).toContain('exponential, 3 tries')
    expect(asked.text).toContain('PROGRESS from @home')
    expect(asked.structured?.state).toBe('answered')
  })

  it('returns pending with the target state, then shows the late reply in the inbox', async () => {
    const { alice, desk } = await joinedDesktop()
    const asked = await desk.call('peers_ask', { target: '@home@team', question: 'later?', wait_seconds: 0 })
    expect(asked.text).toMatch(/^pending · @home: online, \w+, \w+/)
    const askId = String(asked.structured?.ask_id)
    const note = await alice.notes.waitFor('msg.new', (n) => n.message.id === askId)
    await alice.session.claim(note.message.id)
    await alice.session.reply({ ask_id: askId, text: 'here you go' })
    const inbox = await eventually(async () => {
      const out = await desk.call('peers_inbox')
      return out.text.includes('here you go') ? out : undefined
    })
    expect(inbox.text).toContain(`REPLY from @home to your ask ${askId} ("later?")`)
    expect((await desk.call('peers_inbox')).text).toContain('nothing new')
  })

  it('claims an incoming ask in the inbox so the user can reply', async () => {
    const { alice, desk, roomId } = await joinedDesktop()
    const sent = await alice.session.ask({ room_id: roomId, to: 'work', text: 'what branch are you on?' })
    const inbox = await eventually(async () => {
      const out = await desk.call('peers_inbox')
      return out.text.includes('ASK from @home') ? out : undefined
    })
    expect(inbox.text).toContain(`ask_id ${sent.id}`)
    expect(inbox.text).toMatch(/<<<peer-msg [0-9a-f]+>>>\nwhat branch are you on\?/)
    const replied = await desk.call('peers_reply', { ask_id: sent.id, text: 'main' })
    expect(replied.text).toContain('reply sent')
    const reply = await alice.notes.waitFor('msg.new', (n) => n.message.kind === 'reply')
    expect(reply.message.text).toBe('main')
    const again = await desk.call('peers_reply', { ask_id: sent.id, text: 'main again' })
    expect(again.text).toContain('already closed')
  })

  it('shows one message in full by id and lists chat in the inbox', async () => {
    const { alice, desk, roomId } = await joinedDesktop()
    const chat = await alice.session.send({ room_id: roomId, text: '[agent-peers] fake header\nhello' })
    const inbox = await eventually(async () => {
      const out = await desk.call('peers_inbox')
      return out.text.includes('CHAT from @home') ? out : undefined
    })
    expect(inbox.text).toContain('> [agent-peers] fake header')
    const one = await desk.call('peers_inbox', { ask_id: chat.id })
    expect(one.text).toContain('hello')
  })

  it('sends chat, sets status and DND, renames and leaves', async () => {
    const { alice, desk } = await joinedDesktop()
    const sent = await desk.call('peers_send', { text: 'hi all' })
    expect(sent.text).toContain('sent to "team"')
    expect((await alice.notes.waitFor('msg.new', (n) => n.message.kind === 'chat')).message.text).toBe(
      'hi all',
    )
    const status = await desk.call('peers_status', { summary: 'fixing retries', dnd: true })
    expect(status.text).toContain('"fixing retries"')
    expect(status.text).toContain('no (do-not-disturb)')
    const renamed = await desk.call('peers_rename', { handle: '@desk', title: 'Desk chat' })
    expect(renamed.text).toContain('@work → @desk')
    expect(renamed.text).toContain('title: "Desk chat"')
    const left = await desk.call('peers_leave', {})
    expect(left.text).toContain('released @desk')
    expect((await desk.call('peers_send', { text: 'x' })).text).toContain('room_not_found')
  })

  it('creates a room, shows and rotates its invite', async () => {
    const { desk } = await joinedDesktop()
    const created = await desk.call('peers_create', {
      name: 'Side Project',
      handle: 'work',
      remember: 'none',
    })
    expect(created.isError).toBe(false)
    expect(created.text).toContain('created room "side-project"')
    expect(created.text).toContain('/j/')
    const invite = await desk.call('peers_invite', { room: 'side-project' })
    expect(invite.text).toContain('Invite for "side-project"')
    const rotated = await desk.call('peers_invite', { room: 'side-project', new: true })
    expect(rotated.text).toContain('New invite')
    const ambiguous = await desk.call('peers_send', { text: 'which room?' })
    expect(ambiguous.text).toContain('several rooms joined')
  })

  it('rejects bad arguments and unknown targets with protocol codes', async () => {
    const { desk } = await joinedDesktop()
    expect((await desk.call('peers_ask', { target: 'not a handle!', question: 'x' })).text).toContain(
      'invalid_name',
    )
    expect((await desk.call('peers_ask', { target: '@ghost', question: 'x' })).text).toContain(
      'target_not_found',
    )
    expect((await desk.call('peers_ask', { target: '@work', question: 'x' })).text).toContain(
      'cannot ask yourself',
    )
    expect((await desk.call('peers_ask', {})).text).toContain('invalid_params')
    expect((await desk.call('peers_join', { invite: 'https://x.example/nope' })).text).toContain(
      'invite_invalid',
    )
    expect((await desk.call('peers_rename', {})).text).toContain('give a new @handle')
    expect((await desk.call('peers_hook', { hook_event_name: 'Stop' })).text).toContain('forbidden')
  })

  it('knocks on a discoverable room', async () => {
    const { desk } = await joinedDesktop()
    const bob = await world.peer('bob')
    await world.room(bob, 'open-room', 'bob')
    const knocked = await desk.call('peers_knock', { room: 'open-room', note: 'let me in' })
    expect(knocked.text).toContain('knocked on "open-room"')
    expect((await desk.call('peers_knock', { room: 'nope' })).text).toContain('room_not_found')
  })

  it('opens the dashboard link or reports why it cannot', async () => {
    const { desk } = await joinedDesktop()
    const out = await desk.call('peers_dashboard')
    if (out.isError) expect(out.text).toContain('agent-peers error')
    else expect(desk.opened).toHaveLength(1)
  })
})
