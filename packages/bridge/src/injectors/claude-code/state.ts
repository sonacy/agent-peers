/**
 * Small files shared by the short-lived hook processes of one Claude Code session, under
 * `<home>/run/hooks/` (0700 dir, 0600 files):
 *
 * - `bridge-<pid>.json` `{current, previous}`: the conversation a bridge (one Claude Code process)
 *   is running. SessionStart after /clear, /resume or /branch carries only the new `session_id`, so
 *   the hook supersedes the previous one (ARCHITECTURE §5 `register`). Two hooks of the same
 *   SessionStart (sync register + async waiter) compute the same answer in either order.
 * - `inject-<hash>.json` `{inject_ids}`: envelopes handed to this session by `wait` / `take`, so the
 *   Stop hook can confirm them with `turn_end` (the waiter and Stop run in different processes).
 */
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { readJsonFile, writeJsonFile } from '@agent-peers/core'
import { MAX_LOCAL_KEY_LENGTH } from '@agent-peers/protocol'
import { z } from 'zod'

/** SessionStart sources that replace the running conversation with another one. */
export const REPLACING_SOURCES: ReadonlySet<string> = new Set(['clear', 'resume', 'fork', 'branch'])

const KeySchema = z.string().min(1).max(MAX_LOCAL_KEY_LENGTH)
const BridgeKeysSchema = z.object({ current: KeySchema, previous: KeySchema.optional() })
const InjectIdsSchema = z.object({ inject_ids: z.array(z.string().min(1).max(128)).max(256) })

/** Keep the inject-id file bounded: a turn never needs more than this many confirmations. */
const MAX_REMEMBERED_INJECT_IDS = 64

export const hookStateDir = (runDir: string): string => join(runDir, 'hooks')

function keyFile(key: string): string {
  const hash = new Bun.CryptoHasher('sha256').update(key).digest('hex').slice(0, 32)
  return `inject-${hash}.json`
}

export class HookState {
  private readonly dir: string

  constructor(runDir: string) {
    this.dir = hookStateDir(runDir)
  }

  /**
   * Records that bridge `bridgePid` now runs `localKey` and returns the key it supersedes: the
   * previous conversation, but only for replacing sources and only when it differs.
   */
  async noteSessionStart(bridgePid: number, localKey: string, source: string): Promise<string | undefined> {
    const path = this.bridgeFile(bridgePid)
    const known = await this.readBridgeKeys(path)
    // A sibling hook of the same SessionStart already moved `current` to this key.
    const previous = known?.current === localKey ? known.previous : known?.current
    if (known?.current !== localKey)
      await writeJsonFile(path, BridgeKeysSchema, {
        current: localKey,
        ...(previous === undefined ? {} : { previous }),
      })
    if (!REPLACING_SOURCES.has(source) || previous === undefined || previous === localKey) return undefined
    return previous
  }

  /** The conversation bridge `bridgePid` runs now, as the last SessionStart hook recorded it. */
  async currentKey(bridgePid: number): Promise<string | undefined> {
    return (await this.readBridgeKeys(this.bridgeFile(bridgePid)))?.current
  }

  /** Remembers an envelope handed to `localKey` (waiter or prompt hook). */
  async rememberInjectId(localKey: string, injectId: string): Promise<void> {
    const path = join(this.dir, keyFile(localKey))
    const known = await this.loadInjectIds(path)
    if (known.includes(injectId)) return
    const next = [...known, injectId].slice(-MAX_REMEMBERED_INJECT_IDS)
    await writeJsonFile(path, InjectIdsSchema, { inject_ids: next })
  }

  /** The envelopes handed to `localKey` since the last turn end, without forgetting them. */
  readInjectIds(localKey: string): Promise<readonly string[]> {
    return this.loadInjectIds(join(this.dir, keyFile(localKey)))
  }

  /** Returns and forgets the envelopes handed to `localKey` since the last turn end. */
  async takeInjectIds(localKey: string): Promise<readonly string[]> {
    const path = join(this.dir, keyFile(localKey))
    const known = await this.loadInjectIds(path)
    if (known.length > 0) await rm(path, { force: true })
    return known
  }

  private bridgeFile(bridgePid: number): string {
    return join(this.dir, `bridge-${bridgePid}.json`)
  }

  // A corrupt state file reads as absent and is rewritten: it only holds hints for these hooks.
  private readBridgeKeys(path: string): Promise<z.output<typeof BridgeKeysSchema> | null> {
    return readJsonFile(path, BridgeKeysSchema.nullable(), () => null).catch(() => null)
  }

  private async loadInjectIds(path: string): Promise<readonly string[]> {
    const parsed = await readJsonFile(path, InjectIdsSchema.nullable(), () => null).catch(() => null)
    return parsed?.inject_ids ?? []
  }
}
