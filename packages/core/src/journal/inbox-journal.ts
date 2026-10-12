/**
 * Append-only JSONL inbox journal, one file per session (PROTOCOL §6.3, ARCHITECTURE §5).
 * The directory is 0700 and files are 0600. Each record is one O_APPEND write; in-memory state only
 * advances after the write succeeded (the bridge may `msg.ack` as soon as `record` resolves). A torn
 * last line from a crash is skipped on load and the next record starts on a fresh line. When most
 * lines are obsolete (superseded, duplicate or corrupt), the next write rewrites the file compactly
 * through a temp file and an atomic rename.
 */
import { appendFile, chmod, mkdir, rename, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { type Clock, systemClock } from '../util/clock'
import {
  type AskStatus,
  applyRecord,
  createJournalState,
  type Injection,
  type InjectionChannel,
  type JournalEntry,
  type JournalMessage,
  type JournalRecord,
  type MutableJournalState,
  parseRecord,
  snapshotRecords,
  TERMINAL_ASK_STATES,
} from './records'

const DIR_MODE = 0o700
const FILE_MODE = 0o600
const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/
const KNOWN_TYPES: ReadonlySet<string> = new Set(['msg', 'ack', 'ask_state', 'claim', 'inject', 'read'])
/** Files shorter than this are never compacted. */
export const COMPACT_MIN_LINES = 256
/** Compact once the file holds more than this many lines per live record. */
export const COMPACT_RATIO = 2

export class JournalError extends Error {
  override readonly name = 'JournalError'
}

export interface InboxJournalOptions {
  readonly dir: string
  readonly clock?: Clock
  /** Overrides COMPACT_MIN_LINES (tests). */
  readonly compactMinLines?: number
}

/** A journal file as read from disk. */
export interface LoadedJournal {
  readonly lines: readonly string[]
  /** The file did not end with a newline: its last line was torn by a crash. */
  readonly torn: boolean
}

export interface OpenAskQuery {
  /** Only asks addressed to one of these handles. */
  readonly toHandles?: readonly string[]
  /** Include asks already injected into the agent (default false). */
  readonly includeInjected?: boolean
}

export interface RoomAck {
  readonly room_id: string
  readonly seq: number
}

export class SessionJournal {
  private readonly state: MutableJournalState = createJournalState()
  /** Raw lines with a record type this version doesn't know: kept verbatim through compaction. */
  private readonly foreign: string[] = []
  readonly corruptLines: number
  private lineCount: number
  private nextCheck: number
  private needsNewline: boolean
  private chain: Promise<unknown> = Promise.resolve()
  private seq = 0

  constructor(
    readonly sessionId: string,
    readonly file: string,
    loaded: LoadedJournal,
    private readonly clock: Clock,
    private readonly compactMinLines: number = COMPACT_MIN_LINES,
  ) {
    let corrupt = 0
    for (const line of loaded.lines) {
      const record = parseRecord(line)
      if (!record) corrupt += 1
      else if (!applyRecord(this.state, record) && !KNOWN_TYPES.has(record.t)) this.foreign.push(line)
    }
    this.corruptLines = corrupt
    this.lineCount = loaded.lines.length
    this.needsNewline = loaded.torn
    this.nextCheck = Math.max(compactMinLines, this.lineCount)
  }

  /** Journals a message unless (session_id, message id) was seen before. */
  record(message: JournalMessage, options: { replay?: boolean } = {}): Promise<{ added: boolean }> {
    return this.enqueue<{ added: boolean }>(() => {
      if (this.state.entries.has(message.id)) return { record: undefined, result: { added: false } }
      const record: JournalRecord = {
        t: 'msg',
        at: this.clock.now(),
        message,
        replay: options.replay === true,
      }
      return { record, result: { added: true } }
    })
  }

  markAcked(roomId: string, seq: number): Promise<void> {
    return this.append(() => ({ t: 'ack', at: this.clock.now(), room_id: roomId, seq }))
  }

  setAskState(askId: string, state: string, reason?: string): Promise<void> {
    return this.append(() =>
      reason === undefined
        ? { t: 'ask_state', at: this.clock.now(), ask_id: askId, state }
        : { t: 'ask_state', at: this.clock.now(), ask_id: askId, state, reason },
    )
  }

  markClaimed(id: string): Promise<void> {
    return this.append(() => ({ t: 'claim', at: this.clock.now(), id }))
  }

  markInjected(id: string, via: InjectionChannel, injectId: string): Promise<void> {
    return this.append(() => ({ t: 'inject', at: this.clock.now(), id, via, inject_id: injectId }))
  }

  markRead(ids: readonly string[]): Promise<void> {
    return this.append(() => ({ t: 'read', at: this.clock.now(), ids: [...ids] }))
  }

  has(id: string): boolean {
    return this.state.entries.has(id)
  }

  get(id: string): JournalEntry | undefined {
    return this.state.entries.get(id)
  }

  entries(): readonly JournalEntry[] {
    return this.state.order.flatMap((id) => {
      const entry = this.state.entries.get(id)
      return entry ? [entry] : []
    })
  }

  unread(): readonly JournalEntry[] {
    return this.entries().filter((entry) => !entry.read)
  }

  askStatus(askId: string): AskStatus | undefined {
    return this.state.asks.get(askId)
  }

  injection(id: string): Injection {
    return this.state.injections.get(id) ?? { claimed: false }
  }

  /** Asks that are not in a terminal state, oldest first. */
  openAsks(query: OpenAskQuery = {}): readonly JournalEntry[] {
    const handles = query.toHandles ? new Set(query.toHandles) : undefined
    return this.entries().filter((entry) => {
      const { message } = entry
      if (message.kind !== 'ask') return false
      const status = this.state.asks.get(message.id)
      if (status && TERMINAL_ASK_STATES.has(status.state)) return false
      if (handles && !(message.to ?? []).some((h) => handles.has(h))) return false
      return query.includeInjected === true || this.injection(message.id).injected_via === undefined
    })
  }

  ackedSeq(roomId: string): number | undefined {
    return this.state.acked.get(roomId)
  }

  /** Rooms whose highest journaled seq is above the acked seq: what the bridge should `msg.ack`. */
  pendingAcks(): readonly RoomAck[] {
    return [...this.state.maxSeq.entries()]
      .filter(([roomId, seq]) => seq > (this.state.acked.get(roomId) ?? -1))
      .map(([room_id, seq]) => ({ room_id, seq }))
  }

  /** Resolves once every queued write has settled. */
  flush(): Promise<void> {
    return this.chain.then(
      () => undefined,
      () => undefined,
    )
  }

  private append(build: () => JournalRecord): Promise<void> {
    return this.enqueue(() => ({ record: build(), result: undefined }))
  }

  private enqueue<R>(step: () => { record: JournalRecord | undefined; result: R }): Promise<R> {
    const run = async (): Promise<R> => {
      const { record, result } = step()
      if (!record) return result
      await this.write(JSON.stringify(record))
      applyRecord(this.state, record)
      return result
    }
    const next = this.chain.then(run, run)
    this.chain = next.catch(() => undefined)
    return next
  }

  /** Appends one line, or rewrites the file compactly when most of it is obsolete. */
  private async write(line: string): Promise<void> {
    if (this.lineCount + 1 >= this.nextCheck) {
      this.nextCheck = Math.max(this.compactMinLines, (this.lineCount + 1) * COMPACT_RATIO)
      const liveLines = snapshotRecords(this.state, 0).length + this.foreign.length + 1
      if (this.lineCount + 1 > liveLines * COMPACT_RATIO) {
        await this.compact(line)
        return
      }
    }
    try {
      await appendFile(this.file, `${this.needsNewline ? '\n' : ''}${line}\n`, { mode: FILE_MODE })
    } catch (error) {
      // A failed append may leave a partial line behind: start the next one on a fresh line.
      this.needsNewline = true
      throw new JournalError(`failed to write journal for session ${this.sessionId}`, { cause: error })
    }
    this.needsNewline = false
    this.lineCount += 1
  }

  private async compact(line: string): Promise<void> {
    const snapshot = snapshotRecords(this.state, this.clock.now()).map((r) => JSON.stringify(r))
    const lines = [...snapshot, ...this.foreign, line]
    await this.persist(lines)
    this.lineCount = lines.length
    this.needsNewline = false
    this.nextCheck = Math.max(this.compactMinLines, lines.length * COMPACT_RATIO)
  }

  private async persist(lines: readonly string[]): Promise<void> {
    this.seq += 1
    const tmp = `${this.file}.${process.pid}.${this.seq}.tmp`
    try {
      await Bun.write(tmp, `${lines.join('\n')}\n`, { createPath: false })
      await chmod(tmp, FILE_MODE)
      await rename(tmp, this.file)
    } catch (error) {
      await rm(tmp, { force: true })
      throw new JournalError(`failed to write journal for session ${this.sessionId}`, { cause: error })
    }
  }
}

export class InboxJournal {
  private sessions: ReadonlyMap<string, Promise<SessionJournal>> = new Map()

  private constructor(
    readonly dir: string,
    private readonly clock: Clock,
    private readonly compactMinLines: number,
  ) {}

  /** Creates the journal directory (mode 0700) if needed. */
  static async open(options: InboxJournalOptions): Promise<InboxJournal> {
    await mkdir(options.dir, { recursive: true, mode: DIR_MODE })
    await chmod(options.dir, DIR_MODE)
    return new InboxJournal(
      options.dir,
      options.clock ?? systemClock,
      options.compactMinLines ?? COMPACT_MIN_LINES,
    )
  }

  fileFor(sessionId: string): string {
    if (!SESSION_ID_PATTERN.test(sessionId)) throw new JournalError(`invalid session id: ${sessionId}`)
    return join(this.dir, `${sessionId}.jsonl`)
  }

  /** Loads (once) and returns the journal for one session. */
  session(sessionId: string): Promise<SessionJournal> {
    const existing = this.sessions.get(sessionId)
    if (existing) return existing
    const loading = this.load(sessionId)
    this.sessions = new Map(this.sessions).set(sessionId, loading)
    loading.catch(() => {
      const map = new Map(this.sessions)
      map.delete(sessionId)
      this.sessions = map
    })
    return loading
  }

  private async load(sessionId: string): Promise<SessionJournal> {
    const file = this.fileFor(sessionId)
    const handle = Bun.file(file)
    const exists = await handle.exists()
    if (exists) await chmod(file, FILE_MODE)
    const text = exists ? await handle.text() : ''
    const lines = text.split('\n').filter((line) => line.trim().length > 0)
    const torn = text.length > 0 && !text.endsWith('\n')
    return new SessionJournal(sessionId, file, { lines, torn }, this.clock, this.compactMinLines)
  }
}
