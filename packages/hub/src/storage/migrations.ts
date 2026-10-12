/** Schema migrations, applied in order and tracked with `PRAGMA user_version`. */

export const MIGRATIONS: readonly string[] = [
  `
  CREATE TABLE members (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE member_tokens (
    token_hash TEXT PRIMARY KEY,
    member_id TEXT NOT NULL REFERENCES members(id),
    created_at INTEGER NOT NULL,
    revoked_at INTEGER
  );
  CREATE INDEX member_tokens_member ON member_tokens(member_id);

  CREATE TABLE web_sessions (
    token_hash TEXT PRIMARY KEY,
    member_id TEXT NOT NULL REFERENCES members(id),
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  );

  CREATE TABLE login_codes (
    code_hash TEXT PRIMARY KEY,
    member_id TEXT NOT NULL REFERENCES members(id),
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    used_at INTEGER
  );

  CREATE TABLE admin (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    token_hash TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE rooms (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    display_name TEXT,
    description TEXT,
    discoverable INTEGER NOT NULL DEFAULT 1,
    owner_member_id TEXT REFERENCES members(id),
    head_seq INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    dissolved_at INTEGER
  );
  CREATE UNIQUE INDEX rooms_active_name ON rooms(name) WHERE dissolved_at IS NULL;

  CREATE TABLE grants (
    room_id TEXT NOT NULL REFERENCES rooms(id),
    member_id TEXT NOT NULL REFERENCES members(id),
    role TEXT NOT NULL CHECK (role IN ('owner', 'member', 'readonly')),
    created_at INTEGER NOT NULL,
    revoked_at INTEGER,
    kicked INTEGER NOT NULL DEFAULT 0,
    kicked_at INTEGER,
    PRIMARY KEY (room_id, member_id)
  );
  CREATE INDEX grants_member ON grants(member_id);

  CREATE TABLE invites (
    id TEXT PRIMARY KEY,
    room_id TEXT NOT NULL REFERENCES rooms(id),
    code_hash TEXT NOT NULL UNIQUE,
    last4 TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'member',
    created_by TEXT,
    created_at INTEGER NOT NULL,
    closed_at INTEGER,
    closed_reason TEXT
  );
  CREATE UNIQUE INDEX invites_one_active ON invites(room_id) WHERE closed_at IS NULL;

  CREATE TABLE knocks (
    id TEXT PRIMARY KEY,
    room_id TEXT NOT NULL REFERENCES rooms(id),
    member_id TEXT NOT NULL REFERENCES members(id),
    note TEXT,
    state TEXT NOT NULL CHECK (state IN ('pending', 'accepted', 'declined', 'withdrawn', 'expired')),
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    decided_at INTEGER
  );
  CREATE INDEX knocks_room ON knocks(room_id, state);
  CREATE INDEX knocks_member ON knocks(member_id, room_id);

  CREATE TABLE sessions (
    id TEXT PRIMARY KEY,
    member_id TEXT NOT NULL REFERENCES members(id),
    host TEXT NOT NULL,
    agent_kind TEXT NOT NULL,
    local_key TEXT NOT NULL,
    card_json TEXT NOT NULL,
    connection TEXT NOT NULL DEFAULT 'offline' CHECK (connection IN ('online', 'stale', 'offline')),
    outdated INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    last_seen_at INTEGER NOT NULL,
    last_activity_at INTEGER NOT NULL,
    closed_at INTEGER,
    UNIQUE (member_id, host, agent_kind, local_key)
  );

  CREATE TABLE session_rooms (
    session_id TEXT NOT NULL REFERENCES sessions(id),
    room_id TEXT NOT NULL REFERENCES rooms(id),
    handle TEXT NOT NULL,
    PRIMARY KEY (session_id, room_id)
  );

  CREATE TABLE handles (
    room_id TEXT NOT NULL REFERENCES rooms(id),
    handle TEXT NOT NULL,
    member_id TEXT NOT NULL REFERENCES members(id),
    session_id TEXT REFERENCES sessions(id),
    created_at INTEGER NOT NULL,
    PRIMARY KEY (room_id, handle)
  );
  CREATE UNIQUE INDEX handles_session_room ON handles(room_id, session_id) WHERE session_id IS NOT NULL;
  CREATE INDEX handles_session ON handles(session_id);

  CREATE TABLE messages (
    id TEXT PRIMARY KEY,
    room_id TEXT NOT NULL REFERENCES rooms(id),
    seq INTEGER NOT NULL,
    client_msg_id TEXT,
    from_handle TEXT,
    from_member TEXT,
    from_session TEXT,
    kind TEXT NOT NULL,
    to_json TEXT NOT NULL DEFAULT '[]',
    text TEXT NOT NULL,
    re TEXT,
    meta_json TEXT,
    ts INTEGER NOT NULL,
    UNIQUE (room_id, seq)
  );
  CREATE INDEX messages_re ON messages(re);

  CREATE TABLE asks (
    id TEXT PRIMARY KEY REFERENCES messages(id),
    room_id TEXT NOT NULL REFERENCES rooms(id),
    from_handle TEXT NOT NULL,
    from_member_id TEXT NOT NULL,
    from_member TEXT NOT NULL,
    to_handle TEXT NOT NULL,
    state TEXT NOT NULL,
    assignee_session TEXT,
    reason TEXT,
    expires_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX asks_to ON asks(room_id, to_handle, state);
  CREATE INDEX asks_from ON asks(room_id, from_handle, state);
  CREATE INDEX asks_assignee ON asks(assignee_session, state);

  CREATE TABLE cursors (
    room_id TEXT NOT NULL,
    handle TEXT NOT NULL,
    seq INTEGER NOT NULL,
    PRIMARY KEY (room_id, handle)
  );

  CREATE TABLE idempotency (
    session_id TEXT NOT NULL,
    client_msg_id TEXT NOT NULL,
    method TEXT NOT NULL,
    result_json TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (session_id, client_msg_id)
  );

  CREATE TABLE audit (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts INTEGER NOT NULL,
    actor TEXT NOT NULL,
    action TEXT NOT NULL,
    room_id TEXT,
    detail_json TEXT
  );
  `,
]
