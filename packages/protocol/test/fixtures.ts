/** Shared, spec-shaped wire values for the protocol tests. */
export const SID = '01JB0000000000000000000000'
export const RID = '01JC0000000000000000000000'
export const AID = '01JD0000000000000000000000'
export const CODE = '7K3QX9TZ4M2BHC8D'

export const card = {
  session_id: SID,
  member: 'gulei',
  agent: { kind: 'claude-code', version: '2.1.296', adapter: '0.2.0' },
  model: 'claude-opus-5-5',
  host: 'gulei-mbp',
  workspace: { name: 'payments-api', git_remote: 'github.com/acme/payments-api', branch: 'main' },
  title: '调研 T3Code 项目',
  summary: 'refactoring retry policy',
  inject: 'push',
  connection: 'online',
  activity: 'idle',
  accepting: true,
  rooms: [{ room_id: RID, handle: 'work' }],
  last_seen_at: 1791779012000,
  last_activity_at: 1791779000000,
}

export const room = { room_id: RID, name: 'payments-team', display_name: 'Payments', discoverable: true }

export const message = {
  id: AID,
  client_msg_id: AID,
  room_id: RID,
  seq: 1842,
  from: { handle: 'home', member: 'gulei', session_id: SID },
  kind: 'ask',
  to: ['work'],
  text: "what's the retry policy in the payments client?",
  re: null,
  meta: { mode: 'read' },
  ask: { state: 'queued', expires_at: 1791865500000 },
  ts: 1791779100000,
}

export const ask = {
  ask_id: AID,
  room_id: RID,
  from_handle: 'home',
  from_member: 'gulei',
  to_handle: 'work',
  state: 'working',
  assignee_session: SID,
  expires_at: 1791865500000,
} as const

export const knock = {
  knock_id: 'K1',
  room_id: RID,
  member: 'bob',
  note: 'let me in',
  state: 'pending',
  created_at: 1,
  expires_at: 2,
} as const

export const invite = {
  room_id: RID,
  state: 'active',
  code_masked: 'inv_••••••••HC8D',
  role: 'member',
  created_at: 1,
}

const s = { session_id: SID }
const r = { ...s, room_id: RID }

/** For every method: valid params, invalid params, and a valid result. */
export const METHOD_CASES: Record<string, { valid: unknown; invalid: unknown; result: unknown }> = {
  hello: {
    valid: {
      protocol: ['agent-peers/0.3'],
      bridge: { agent_kind: 'codex', agent_version: '0.157.0', adapter: '0.2.0', host: 'mbp' },
    },
    invalid: { protocol: [], bridge: { agent_kind: 'codex', adapter: '0.2.0', host: 'mbp' } },
    result: {
      protocol: 'agent-peers/0.3',
      heartbeat_ms: 15000,
      grace_ms: 90000,
      server_time: 1,
      min_adapter: '0.2.0',
    },
  },
  ping: { valid: {}, invalid: 'x', result: { server_time: 5 } },
  'session.open': {
    valid: {
      local_key: 'claude-uuid',
      card: { agent: { kind: 'claude-code' }, host: 'mbp' },
      supersedes: 'old',
    },
    invalid: { local_key: '', card: { agent: { kind: 'claude-code' }, host: 'mbp' } },
    result: {
      session_id: SID,
      rooms: [
        { room, handle: 'work' },
        { room_id: RID, handle: 'w2', status: 'held' },
      ],
    },
  },
  'session.close': { valid: s, invalid: {}, result: {} },
  'session.update': {
    valid: { ...s, activity: 'busy', inject: 'boundary' },
    invalid: { ...s, activity: 'asleep' },
    result: {},
  },
  'session.rename': {
    valid: { ...s, handle: 'job', room_id: RID },
    invalid: { ...s, room_id: RID },
    result: { title: null, rooms: [{ room_id: RID, old: 'work', new: 'job' }] },
  },
  'dashboard.login': {
    valid: s,
    invalid: { session_id: 'has space' },
    result: { code: 'c', url: 'https://h/app/login?c=c' },
  },
  bye: { valid: {}, invalid: [], result: undefined },
  'room.join': {
    valid: { ...s, room_name: 'timely', handle: 'work' },
    invalid: { ...s, room_id: RID, invite_code: CODE },
    result: { room, handle: 'work', members: [{ room_id: RID, handle: 'work', card }] },
  },
  'room.search': {
    valid: { ...s, q: 'api' },
    invalid: { ...s, q: 'x'.repeat(101) },
    result: {
      rooms: [{ room_id: RID, name: 'timely', owner: 'bob', member_count: 3, my_state: 'knocking' }],
    },
  },
  'room.knock': { valid: { ...r, note: 'hi' }, invalid: { ...s }, result: { knock_id: 'K1' } },
  'knock.withdraw': { valid: { ...s, knock_id: 'K1' }, invalid: s, result: {} },
  'knock.decide': {
    valid: { ...s, knock_id: 'K1', decision: 'accept' },
    invalid: { ...s, knock_id: 'K1', decision: 'maybe' },
    result: {},
  },
  'room.remove_session': { valid: { ...r, target_session_id: SID }, invalid: r, result: {} },
  'room.exit': { valid: r, invalid: s, result: {} },
  'room.dissolve': { valid: r, invalid: { room_id: RID }, result: {} },
  'invite.rotate': {
    valid: r,
    invalid: s,
    result: { invite_url: `https://h/j/${CODE}`, join_prompt: 'Join…' },
  },
  'invite.close': { valid: r, invalid: s, result: {} },
  'invite.reopen': { valid: r, invalid: s, result: { invite_url: `https://h/j/${CODE}` } },
  'room.create': {
    valid: { ...s, name: 'payments-team', description: 'pay', handle: 'api', discoverable: false },
    invalid: { ...s, name: 'Payments Team' },
    result: { room, handle: 'api', invite_url: `https://h/j/${CODE}` },
  },
  'invite.create': {
    valid: { ...r, uses: 5, expires_ms: 1000, role: 'readonly', lang: 'zh', suggested_handle: 'api' },
    invalid: { ...r, role: 'owner' },
    result: { invite_url: `https://h/j/${CODE}`, expires_at: null, join_prompt: 'p', join_command: 'c' },
  },
  'room.kick': { valid: { ...r, member: 'bob' }, invalid: { ...r, member: 'Bob!' }, result: {} },
  'room.leave': { valid: r, invalid: { ...s, room_id: '' }, result: {} },
  'room.list': {
    valid: s,
    invalid: { session_id: 5 },
    result: { rooms: [{ room, handle: 'work', unread: 2 }] },
  },
  'peers.list': {
    valid: s,
    invalid: { ...s, room_id: 7 },
    result: { members: [{ room_id: RID, handle: 'work', card }] },
  },
  'msg.send': {
    valid: {
      ...s,
      client_msg_id: AID,
      room_id: RID,
      kind: 'ask',
      to: ['work'],
      text: 'q?',
      ttl_ms: 1000,
      require_online: true,
    },
    invalid: { ...s, client_msg_id: AID, room_id: RID, kind: 'ask', to: ['a', 'b'], text: 'q?' },
    result: { id: AID, seq: 1, ask: { state: 'queued', expires_at: 9 } },
  },
  'msg.reply': {
    valid: { ...s, client_msg_id: AID, ask_id: AID, text: 'a', state: 'declined', meta: { auto: true } },
    invalid: { ...s, client_msg_id: AID, ask_id: AID, text: 'a', state: 'working' },
    result: { id: AID, seq: 2 },
  },
  'msg.progress': {
    valid: { ...s, client_msg_id: AID, ask_id: AID, text: 'half way' },
    invalid: { ...s, ask_id: AID, text: 'x' },
    result: { id: AID, seq: 3 },
  },
  'ask.claim': { valid: { ...s, ask_id: AID }, invalid: s, result: { ask } },
  'ask.cancel': { valid: { ...s, ask_id: AID }, invalid: { ask_id: AID }, result: {} },
  'ask.get': { valid: { ...s, ask_id: AID }, invalid: s, result: { ask, messages: [message] } },
  'msg.ack': { valid: { ...r, seq: 9 }, invalid: { ...r, seq: -1 }, result: {} },
  'msg.history': {
    valid: { ...r, before_seq: 100, limit: 200 },
    invalid: { ...r, limit: 201 },
    result: { messages: [message] },
  },
}
