import { describe, expect, it } from 'bun:test'
import { databasePath, migrate, openDatabase, schemaVersion } from '../../src/storage/db'
import { MIGRATIONS } from '../../src/storage/migrations'
import { createRepos } from '../../src/storage/repos'

describe('storage', () => {
  it('migrates once and records the version', () => {
    const db = openDatabase(':memory:')
    expect(schemaVersion(db)).toBe(MIGRATIONS.length)
    expect(migrate(db)).toBe(MIGRATIONS.length)
    db.close()
  })

  it('maps data dirs to database paths', () => {
    expect(databasePath(':memory:')).toBe(':memory:')
    expect(databasePath('/tmp/x')).toBe('/tmp/x/hub.db')
  })

  it('keeps room names unique among active rooms only', () => {
    const db = openDatabase(':memory:')
    const repos = createRepos(db)
    repos.rooms.insert({ id: 'r1', name: 'team', discoverable: true, owner_member_id: null, created_at: 1 })
    expect(() =>
      repos.rooms.insert({
        id: 'r2',
        name: 'team',
        discoverable: true,
        owner_member_id: null,
        created_at: 1,
      }),
    ).toThrow()
    repos.rooms.dissolve('r1', 2)
    repos.rooms.insert({ id: 'r3', name: 'team', discoverable: true, owner_member_id: null, created_at: 3 })
    expect(repos.rooms.activeByName('team')?.id).toBe('r3')
    expect(repos.rooms.nextSeq('r3')).toBe(1)
    expect(repos.rooms.nextSeq('r3')).toBe(2)
    expect(() => repos.rooms.nextSeq('missing')).toThrow()
    db.close()
  })

  it('escapes LIKE wildcards in room search', () => {
    const db = openDatabase(':memory:')
    const repos = createRepos(db)
    repos.rooms.insert({ id: 'r1', name: 'a_b', discoverable: true, owner_member_id: null, created_at: 1 })
    repos.rooms.insert({ id: 'r2', name: 'axb', discoverable: true, owner_member_id: null, created_at: 1 })
    repos.rooms.insert({
      id: 'r3',
      name: 'hidden',
      discoverable: false,
      owner_member_id: null,
      created_at: 1,
    })
    expect(repos.rooms.search('_', 10).map((r) => r.name)).toEqual(['a_b'])
    expect(repos.rooms.search('', 10)).toHaveLength(2)
    db.close()
  })

  it('enforces one active invite per room and records audit', () => {
    const db = openDatabase(':memory:')
    const repos = createRepos(db)
    repos.rooms.insert({ id: 'r1', name: 'team', discoverable: true, owner_member_id: null, created_at: 1 })
    const invite = { room_id: 'r1', last4: 'ABCD', role: 'member' as const, created_by: null, created_at: 1 }
    repos.invites.insert({ ...invite, id: 'i1', code_hash: 'h1' })
    expect(() => repos.invites.insert({ ...invite, id: 'i2', code_hash: 'h2' })).toThrow()
    repos.invites.close('i1', 2, 'rotated')
    repos.invites.insert({ ...invite, id: 'i2', code_hash: 'h2', created_at: 3 })
    expect(repos.invites.listActive().map((i) => i.id)).toEqual(['i2'])
    expect(repos.invites.byId('i1')?.closed_reason).toBe('rotated')
    repos.audit.insert({ ts: 1, actor: 'admin', action: 'x', roomId: 'r1', detail: { a: 1 } })
    repos.audit.insert({ ts: 2, actor: 'admin', action: 'y' })
    expect(repos.audit.list(10)).toHaveLength(2)
    expect(repos.audit.list(10, 'r1')[0]?.detail_json).toBe('{"a":1}')
    db.close()
  })

  it('consumes login codes once and expires web sessions', () => {
    const db = openDatabase(':memory:')
    const repos = createRepos(db)
    repos.members.insert({ id: 'm1', name: 'alice', created_at: 1 })
    expect(repos.members.list()).toHaveLength(1)
    repos.loginCodes.insert({ code_hash: 'c', member_id: 'm1', created_at: 1, expires_at: 100 })
    expect(repos.loginCodes.consume('c', 50)).toBe(true)
    expect(repos.loginCodes.consume('c', 51)).toBe(false)
    expect(repos.loginCodes.deleteExpired(200)).toBe(1)
    repos.webSessions.insert({ token_hash: 't', member_id: 'm1', created_at: 1, expires_at: 10 })
    expect(repos.webSessions.deleteExpired(20)).toBe(1)
    db.close()
  })
})
