/** Journal record shapes and the pure reducer that rebuilds per-session inbox state from them. */

/** The subset of a protocol message (PROTOCOL §6.1) the journal relies on. */
export interface JournalMessage {
  readonly id: string
  readonly room_id: string
  readonly seq: number
  readonly kind: string
  readonly to?: readonly string[] | null
  readonly re?: string | null
  readonly ask?: { readonly state: string; readonly expires_at?: number } | null
  readonly [key: string]: unknown
}

export type InjectionChannel = string

export type JournalRecord =
  | { readonly t: 'msg'; readonly at: number; readonly message: JournalMessage; readonly replay?: boolean }
  | { readonly t: 'ack'; readonly at: number; readonly room_id: string; readonly seq: number }
  | {
      readonly t: 'ask_state'
      readonly at: number
      readonly ask_id: string
      readonly state: string
      readonly reason?: string
    }
  | { readonly t: 'claim'; readonly at: number; readonly id: string }
  | {
      readonly t: 'inject'
      readonly at: number
      readonly id: string
      readonly via: InjectionChannel
      readonly inject_id: string
    }
  | { readonly t: 'read'; readonly at: number; readonly ids: readonly string[] }

export interface Injection {
  readonly claimed: boolean
  readonly injected_via?: InjectionChannel
  readonly inject_id?: string
  readonly injected_at?: number
}

export interface JournalEntry {
  readonly message: JournalMessage
  readonly received_at: number
  readonly replay: boolean
  readonly read: boolean
}

export interface AskStatus {
  readonly state: string
  readonly reason?: string
}

export interface JournalState {
  readonly entries: ReadonlyMap<string, JournalEntry>
  readonly order: readonly string[]
  readonly acked: ReadonlyMap<string, number>
  readonly maxSeq: ReadonlyMap<string, number>
  readonly asks: ReadonlyMap<string, AskStatus>
  readonly injections: ReadonlyMap<string, Injection>
}

export const TERMINAL_ASK_STATES: ReadonlySet<string> = new Set([
  'answered',
  'declined',
  'failed',
  'expired',
  'cancelled',
])

/**
 * The journal's working state. Its maps are mutated in place while records are folded in, so
 * loading and appending stay linear; it never leaves the SessionJournal that owns it, which only
 * hands out immutable entries and fresh arrays.
 */
export interface MutableJournalState extends JournalState {
  readonly entries: Map<string, JournalEntry>
  readonly order: string[]
  readonly acked: Map<string, number>
  readonly maxSeq: Map<string, number>
  readonly asks: Map<string, AskStatus>
  readonly injections: Map<string, Injection>
}

export function createJournalState(): MutableJournalState {
  return {
    entries: new Map(),
    order: [],
    acked: new Map(),
    maxSeq: new Map(),
    asks: new Map(),
    injections: new Map(),
  }
}

function raiseTo(map: Map<string, number>, key: string, value: number): void {
  const current = map.get(key)
  if (current === undefined || current < value) map.set(key, value)
}

function applyMessage(state: MutableJournalState, record: Extract<JournalRecord, { t: 'msg' }>): boolean {
  const { message } = record
  if (state.entries.has(message.id)) return false
  state.entries.set(message.id, {
    message,
    received_at: record.at,
    replay: record.replay === true,
    read: false,
  })
  state.order.push(message.id)
  raiseTo(state.maxSeq, message.room_id, message.seq)
  if (message.kind === 'ask' && message.ask && !state.asks.has(message.id))
    state.asks.set(message.id, { state: message.ask.state })
  return true
}

function applyInjection(state: MutableJournalState, id: string, patch: Partial<Injection>): boolean {
  const current = state.injections.get(id) ?? { claimed: false }
  state.injections.set(id, { ...current, ...patch })
  return true
}

function applyRead(state: MutableJournalState, ids: readonly string[]): boolean {
  let changed = false
  for (const id of ids) {
    const entry = state.entries.get(id)
    if (entry && !entry.read) {
      state.entries.set(id, { ...entry, read: true })
      changed = true
    }
  }
  return changed
}

/**
 * Applies `record` to the state in place. Returns false when it changed nothing (a duplicate
 * message, an unknown record type), which is what makes a journal line obsolete.
 */
export function applyRecord(state: MutableJournalState, record: JournalRecord): boolean {
  switch (record.t) {
    case 'msg':
      return applyMessage(state, record)
    case 'ack':
      raiseTo(state.acked, record.room_id, record.seq)
      return true
    case 'ask_state':
      state.asks.set(
        record.ask_id,
        record.reason === undefined
          ? { state: record.state }
          : { state: record.state, reason: record.reason },
      )
      return true
    case 'claim':
      return applyInjection(state, record.id, { claimed: true })
    case 'inject':
      return applyInjection(state, record.id, {
        injected_via: record.via,
        inject_id: record.inject_id,
        injected_at: record.at,
      })
    case 'read':
      return applyRead(state, record.ids)
    default:
      return false
  }
}

/** Folds records into a fresh state (load and tests). */
export function foldRecords(records: Iterable<JournalRecord>): JournalState {
  const state = createJournalState()
  for (const record of records) applyRecord(state, record)
  return state
}

const READ_IDS_PER_RECORD = 500

function injectionRecords(id: string, injection: Injection, at: number): readonly JournalRecord[] {
  const claim: JournalRecord[] = injection.claimed ? [{ t: 'claim', at, id }] : []
  if (injection.injected_via === undefined) return claim
  const inject: JournalRecord = {
    t: 'inject',
    at: injection.injected_at ?? at,
    id,
    via: injection.injected_via,
    inject_id: injection.inject_id ?? '',
  }
  return [...claim, inject]
}

function readRecords(state: JournalState, at: number): readonly JournalRecord[] {
  const ids = state.order.filter((id) => state.entries.get(id)?.read === true)
  const chunks: JournalRecord[] = []
  for (let i = 0; i < ids.length; i += READ_IDS_PER_RECORD)
    chunks.push({ t: 'read', at, ids: ids.slice(i, i + READ_IDS_PER_RECORD) })
  return chunks
}

/** The fewest records that rebuild `state`: what a compacted journal file holds. */
export function snapshotRecords(state: JournalState, at: number): readonly JournalRecord[] {
  const messages = state.order.flatMap((id): JournalRecord[] => {
    const entry = state.entries.get(id)
    return entry ? [{ t: 'msg', at: entry.received_at, message: entry.message, replay: entry.replay }] : []
  })
  const acks = [...state.acked].map(([room_id, seq]): JournalRecord => ({ t: 'ack', at, room_id, seq }))
  const asks = [...state.asks].map(
    ([ask_id, status]): JournalRecord =>
      status.reason === undefined
        ? { t: 'ask_state', at, ask_id, state: status.state }
        : { t: 'ask_state', at, ask_id, state: status.state, reason: status.reason },
  )
  const injections = [...state.injections].flatMap(([id, injection]) => injectionRecords(id, injection, at))
  return [...messages, ...acks, ...asks, ...injections, ...readRecords(state, at)]
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isMessage(value: unknown): value is JournalMessage {
  return (
    isObject(value) &&
    typeof value.id === 'string' &&
    typeof value.room_id === 'string' &&
    typeof value.seq === 'number' &&
    typeof value.kind === 'string'
  )
}

const isString = (v: unknown): v is string => typeof v === 'string'
const isNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

const RECORD_CHECKS: Readonly<Record<string, (value: Record<string, unknown>) => boolean>> = {
  msg: (v) => isMessage(v.message),
  ack: (v) => isString(v.room_id) && isNumber(v.seq),
  ask_state: (v) => isString(v.ask_id) && isString(v.state),
  claim: (v) => isString(v.id),
  inject: (v) => isString(v.id) && isString(v.via) && isString(v.inject_id),
  read: (v) => Array.isArray(v.ids) && v.ids.every(isString),
}

/**
 * Parses one JSONL line. Returns `undefined` for lines that are not a well-formed record.
 * Records with an unknown `t` are returned as-is so newer journals still load (the reducer ignores them).
 */
export function parseRecord(line: string): JournalRecord | undefined {
  let value: unknown
  try {
    value = JSON.parse(line)
  } catch {
    return undefined
  }
  if (!isObject(value) || !isString(value.t) || !isNumber(value.at)) return undefined
  const check = RECORD_CHECKS[value.t]
  if (check && !check(value)) return undefined
  return value as unknown as JournalRecord
}
