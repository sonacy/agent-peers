import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { InboxJournal, JournalError } from '../src/journal/inbox-journal'
import {
  applyRecord,
  createJournalState,
  foldRecords,
  type JournalRecord,
  parseRecord,
  snapshotRecords,
} from '../src/journal/records'

let dir: string
let now = 1_000
const clock = { now: () => now, setTimeout: () => 0, clearTimeout: () => undefined }

const ask = (id: string, seq: number, to = ['work']) => ({
  id,
  room_id: 'room1',
  seq,
  kind: 'ask',
  to,
  text: `question ${id}`,
  ask: { state: 'queued', expires_at: 99 },
})
const chat = (id: string, seq: number, room = 'room1') => ({ id, room_id: room, seq, kind: 'chat', text: id })

beforeEach(async () => {
  dir = join(await mkdtemp(join(tmpdir(), 'peers-journal-')), 'inbox')
})

afterEach(async () => {
  await rm(join(dir, '..'), { recursive: true, force: true })
})

describe('InboxJournal', () => {
  it('creates a 0700 dir and 0600 files', async () => {
    const journal = await InboxJournal.open({ dir, clock })
    const s = await journal.session('S1')
    await s.record(chat('m1', 1))
    expect((await stat(dir)).mode & 0o777).toBe(0o700)
    expect((await stat(journal.fileFor('S1'))).mode & 0o777).toBe(0o600)
  })

  it('dedupes by (session, message id) and persists JSONL', async () => {
    const journal = await InboxJournal.open({ dir, clock })
    const s = await journal.session('S1')
    expect(await s.record(chat('m1', 1))).toEqual({ added: true })
    expect(await s.record(chat('m1', 1))).toEqual({ added: false })
    const other = await journal.session('S2')
    expect(await other.record(chat('m1', 1))).toEqual({ added: true })
    const text = await readFile(journal.fileFor('S1'), 'utf8')
    expect(text.trim().split('\n')).toHaveLength(1)
    expect(s.has('m1')).toBe(true)
    expect(s.get('m1')?.received_at).toBe(1000)
  })

  it('serializes concurrent writes', async () => {
    const journal = await InboxJournal.open({ dir, clock })
    const s = await journal.session('S1')
    const results = await Promise.all([
      s.record(chat('a', 1)),
      s.record(chat('a', 1)),
      s.record(chat('b', 2)),
    ])
    expect(results.map((r) => r.added)).toEqual([true, false, true])
    expect(s.entries().map((e) => e.message.id)).toEqual(['a', 'b'])
  })

  it('tracks acks per room', async () => {
    const journal = await InboxJournal.open({ dir, clock })
    const s = await journal.session('S1')
    await s.record(chat('a', 5))
    await s.record(chat('b', 7))
    await s.record(chat('c', 3, 'room2'))
    expect(s.pendingAcks()).toEqual([
      { room_id: 'room1', seq: 7 },
      { room_id: 'room2', seq: 3 },
    ])
    await s.markAcked('room1', 7)
    await s.markAcked('room1', 2)
    expect(s.ackedSeq('room1')).toBe(7)
    expect(s.pendingAcks()).toEqual([{ room_id: 'room2', seq: 3 }])
  })

  it('tracks injection state and open asks', async () => {
    const journal = await InboxJournal.open({ dir, clock })
    const s = await journal.session('S1')
    await s.record(ask('a1', 1), { replay: true })
    await s.record(ask('a2', 2, ['other']))
    await s.record(ask('a3', 3))
    expect(s.get('a1')?.replay).toBe(true)
    expect(s.openAsks({ toHandles: ['work'] }).map((e) => e.message.id)).toEqual(['a1', 'a3'])
    await s.markClaimed('a1')
    now = 2_000
    await s.markInjected('a1', 'hook', 'inj-1')
    expect(s.injection('a1')).toEqual({
      claimed: true,
      injected_via: 'hook',
      inject_id: 'inj-1',
      injected_at: 2000,
    })
    expect(s.injection('zzz')).toEqual({ claimed: false })
    expect(s.openAsks({ toHandles: ['work'] }).map((e) => e.message.id)).toEqual(['a3'])
    expect(s.openAsks({ includeInjected: true }).map((e) => e.message.id)).toEqual(['a1', 'a2', 'a3'])
    await s.setAskState('a3', 'cancelled')
    await s.setAskState('a2', 'failed', 'target_lost')
    expect(s.askStatus('a2')).toEqual({ state: 'failed', reason: 'target_lost' })
    expect(s.openAsks({ includeInjected: true }).map((e) => e.message.id)).toEqual(['a1'])
  })

  it('tracks unread', async () => {
    const journal = await InboxJournal.open({ dir, clock })
    const s = await journal.session('S1')
    await s.record(chat('a', 1))
    await s.record(chat('b', 2))
    await s.markRead(['a', 'missing'])
    expect(s.unread().map((e) => e.message.id)).toEqual(['b'])
  })

  it('reloads state from disk and skips corrupt lines', async () => {
    const first = await InboxJournal.open({ dir, clock })
    const s = await first.session('S1')
    await s.record(ask('a1', 4))
    await s.markClaimed('a1')
    await s.markAcked('room1', 4)
    await s.markRead(['a1'])
    await s.flush()
    const file = first.fileFor('S1')
    const original = await readFile(file, 'utf8')
    await writeFile(file, `${original}not json\n{"t":"ack","at":1}\n{"t":"future","at":1}\n`)
    const second = await InboxJournal.open({ dir, clock })
    const reloaded = await second.session('S1')
    expect(reloaded.corruptLines).toBe(2)
    expect(reloaded.has('a1')).toBe(true)
    expect(reloaded.injection('a1').claimed).toBe(true)
    expect(reloaded.ackedSeq('room1')).toBe(4)
    expect(reloaded.unread()).toEqual([])
    await reloaded.record(chat('z', 5))
    const after = await readFile(file, 'utf8')
    expect(after).toContain('not json')
  })

  it('caches session journals and rejects bad session ids', async () => {
    const journal = await InboxJournal.open({ dir, clock })
    expect(await journal.session('S1')).toBe(await journal.session('S1'))
    await expect(journal.session('../evil')).rejects.toBeInstanceOf(JournalError)
    expect(() => journal.fileFor('a/b')).toThrow(JournalError)
  })

  it('surfaces write failures without advancing state', async () => {
    const journal = await InboxJournal.open({ dir, clock })
    const s = await journal.session('S1')
    await rm(dir, { recursive: true, force: true })
    await expect(s.record(chat('a', 1))).rejects.toBeInstanceOf(JournalError)
    expect(s.has('a')).toBe(false)
    await s.flush()
  })
})

describe('records', () => {
  it('parses only well-formed records', () => {
    expect(parseRecord('{')).toBeUndefined()
    expect(parseRecord('[]')).toBeUndefined()
    expect(parseRecord('{"t":"msg","at":1,"message":{"id":"x"}}')).toBeUndefined()
    expect(parseRecord('{"t":"read","at":1,"ids":[1]}')).toBeUndefined()
    expect(parseRecord('{"t":"inject","at":1,"id":"x","via":"hook","inject_id":"i"}')).toEqual({
      t: 'inject',
      at: 1,
      id: 'x',
      via: 'hook',
      inject_id: 'i',
    })
  })

  it('reducer reports duplicate messages and unknown records as no-ops', () => {
    const msg = { t: 'msg', at: 1, message: chat('a', 1) } as const
    const state = createJournalState()
    expect(applyRecord(state, msg)).toBe(true)
    expect(applyRecord(state, msg)).toBe(false)
    expect(applyRecord(state, { t: 'nope', at: 1 } as never)).toBe(false)
    expect(applyRecord(state, { t: 'read', at: 1, ids: ['zzz'] })).toBe(false)
    expect(state.order).toEqual(['a'])
  })

  it('snapshots the fewest records that rebuild the same state', () => {
    const records: JournalRecord[] = [
      { t: 'msg', at: 1, message: ask('q1', 1), replay: true },
      { t: 'msg', at: 2, message: chat('c1', 2) },
      { t: 'msg', at: 2, message: chat('c1', 2) },
      { t: 'ack', at: 3, room_id: 'room1', seq: 1 },
      { t: 'ack', at: 4, room_id: 'room1', seq: 2 },
      { t: 'ask_state', at: 5, ask_id: 'q1', state: 'working' },
      { t: 'ask_state', at: 6, ask_id: 'q1', state: 'failed', reason: 'target_lost' },
      { t: 'claim', at: 7, id: 'q1' },
      { t: 'inject', at: 8, id: 'q1', via: 'hook', inject_id: 'i1' },
      { t: 'inject', at: 9, id: 'c1', via: 'poll', inject_id: 'i2' },
      { t: 'read', at: 10, ids: ['c1'] },
    ]
    const state = foldRecords(records)
    const snapshot = snapshotRecords(state, 99)
    expect(snapshot.length).toBeLessThan(records.length)
    expect(foldRecords(snapshot)).toEqual(state)
  })
})

describe('journal file format', () => {
  const lines = async (file: string) => (await readFile(file, 'utf8')).split('\n').filter(Boolean)

  it('appends one line per record instead of rewriting the file', async () => {
    const journal = await InboxJournal.open({ dir, clock })
    const s = await journal.session('S1')
    await s.record(chat('a', 1))
    const before = await readFile(journal.fileFor('S1'), 'utf8')
    await s.markAcked('room1', 1)
    await s.markRead(['a'])
    const after = await readFile(journal.fileFor('S1'), 'utf8')
    expect(after.startsWith(before)).toBe(true)
    expect(await lines(journal.fileFor('S1'))).toHaveLength(3)
  })

  it('starts on a fresh line after a torn last line', async () => {
    const journal = await InboxJournal.open({ dir, clock })
    const file = journal.fileFor('S1')
    await writeFile(file, `${JSON.stringify({ t: 'msg', at: 1, message: chat('a', 1) })}\n{"t":"msg","at`)
    const s = await journal.session('S1')
    expect(s.corruptLines).toBe(1)
    await s.record(chat('b', 2))
    const reloaded = await (await InboxJournal.open({ dir, clock })).session('S1')
    expect(reloaded.entries().map((e) => e.message.id)).toEqual(['a', 'b'])
    expect(reloaded.corruptLines).toBe(1)
  })

  it('compacts once most lines are obsolete, keeping state and unknown records', async () => {
    const journal = await InboxJournal.open({ dir, clock, compactMinLines: 8 })
    const file = journal.fileFor('S1')
    await writeFile(file, `{"t":"future","at":1,"x":1}\nnot json\n`)
    const s = await journal.session('S1')
    await s.record(ask('q1', 1))
    for (let seq = 1; seq <= 20; seq += 1) await s.markAcked('room1', seq)
    await s.markClaimed('q1')
    await s.markRead(['q1'])
    const written = await lines(file)
    expect(written.length).toBeLessThan(17)
    expect(written).toContain('{"t":"future","at":1,"x":1}')
    expect(written).not.toContain('not json')
    const reloaded = await (await InboxJournal.open({ dir, clock })).session('S1')
    expect(reloaded.ackedSeq('room1')).toBe(20)
    expect(reloaded.injection('q1').claimed).toBe(true)
    expect(reloaded.unread()).toEqual([])
    expect(reloaded.corruptLines).toBe(0)
    expect((await stat(file)).mode & 0o777).toBe(0o600)
  })

  it('surfaces a failed compaction without advancing state', async () => {
    const journal = await InboxJournal.open({ dir, clock, compactMinLines: 2 })
    const s = await journal.session('S1')
    await s.record(chat('a', 1))
    await s.markAcked('room1', 1)
    await rm(dir, { recursive: true, force: true })
    await expect(s.markAcked('room1', 1)).rejects.toBeInstanceOf(JournalError)
    await expect(s.record(chat('b', 2))).rejects.toBeInstanceOf(JournalError)
    expect(s.has('b')).toBe(false)
  })
})
