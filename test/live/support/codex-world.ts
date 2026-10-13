/**
 * The shared fixture of the Codex live suite: an isolated Codex install with the peers plugin, a real
 * hub (in-process, port 0, in-memory SQLite), a scripted bot in the room, and an app-server client
 * attached to this CODEX_HOME's shared daemon. Also the observations the final report prints.
 */
import type { CardView, E2eHub, E2eRoom } from '../../e2e/support/hub'
import { startE2eHub } from '../../e2e/support/hub'
import { type Bot, startBot } from './codex-bot'
import {
  type CodexLiveEnv,
  createCodexEnv,
  FRESH_BIN,
  installPlugin,
  startDaemon,
  trustPeersHooks,
} from './codex-env'
import type { CodexRpc } from './codex-rpc'
import { approvePeersOnly } from './codex-thread'

export const BOT_ANSWER = 'The code word is PINEAPPLE-42.'

export interface CodexWorld {
  readonly live: CodexLiveEnv
  readonly hub: E2eHub
  readonly room: E2eRoom
  readonly bot: Bot
  readonly workspaces: { readonly a: string; readonly b: string }
  rpc: CodexRpc | undefined
  readonly notes: string[]
  note(line: string): void
  codexCards(): Promise<readonly CardView[]>
  cardOf(handle: string): Promise<CardView | undefined>
  bridgeLogTail(lines?: number): Promise<string>
  /** Bridge processes of this world (`agent-peers mcp` whose environment names the temp root). */
  bridgePids(): readonly number[]
  close(): Promise<void>
}

export async function waitUntil<T>(
  what: string,
  probe: () => Promise<T | undefined | false> | T | undefined | false,
  timeoutMs = 30_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await probe()
    if (value !== undefined && value !== false) return value
    if (Date.now() > deadline) throw new Error(`timed out after ${timeoutMs} ms waiting for ${what}`)
    await Bun.sleep(250)
  }
}

function bridgePidsUnder(root: string): readonly number[] {
  const ps = Bun.spawnSync(['ps', '-axwwE', '-o', 'pid=,command='], { stdout: 'pipe' })
  return ps.stdout
    .toString()
    .split('\n')
    .filter((line) => line.includes(`${FRESH_BIN} mcp`) && line.includes(root))
    .map((line) => Number.parseInt(line.trim(), 10))
}

export async function prepareCodex(
  live: CodexLiveEnv,
  cwd: string,
  note: (line: string) => void,
): Promise<void> {
  const install = await installPlugin(live)
  note(
    `install: exit ${install.exitCode}; ${install.stdout
      .split('\n')
      .filter((l) => /->|FINISH|selftest/.test(l))
      .join(' | ')}`,
  )
  if (install.exitCode !== 0) throw new Error(`agent-peers add failed:\n${install.stdout}\n${install.stderr}`)
  const embedded = await live.appServer('embedded', cwd, approvePeersOnly)
  try {
    const hooks = await trustPeersHooks(embedded, cwd)
    note(
      `hooks trusted via hooks/list + config/batchWrite: ${hooks.map((h) => `${h.eventName}=${h.trustStatus}`).join(', ')}`,
    )
    if (hooks.length === 0 || hooks.some((h) => h.trustStatus !== 'trusted'))
      throw new Error(`peers hooks not trusted: ${JSON.stringify(hooks)}`)
  } finally {
    await embedded.close()
  }
  const daemon = await startDaemon(live)
  note(
    `daemon: ${daemon.status} (${daemon.backend}) socket ${String(daemon.socketPath).replace(live.root, '<root>')}`,
  )
}

export async function createCodexWorld(): Promise<CodexWorld> {
  const live = await createCodexEnv()
  const notes: string[] = []
  const note = (line: string) => {
    notes.push(line)
    process.stderr.write(`[codex-live] ${line}\n`)
  }
  let hub: E2eHub | undefined
  let bot: Bot | undefined
  try {
    const a = await live.workspace('ws-a')
    const b = await live.workspace('ws-b')
    await prepareCodex(live, a, note)
    hub = await startE2eHub()
    const room = await hub.createRoom('live-codex')
    bot = await startBot({ hub, room, handle: 'bot', answer: BOT_ANSWER })
    const rpc = await live.appServer('daemon', a, approvePeersOnly)
    return world({ live, hub, room, bot, workspaces: { a, b }, rpc, notes, note })
  } catch (error) {
    await bot?.close().catch(() => undefined)
    await hub?.stop().catch(() => undefined)
    await live.cleanup()
    throw error
  }
}

type Parts = Pick<CodexWorld, 'live' | 'hub' | 'room' | 'bot' | 'workspaces' | 'notes' | 'note'> & {
  rpc: CodexRpc
}

function world(parts: Parts): CodexWorld {
  const { live, hub } = parts
  const codexCards = async () => (await hub.sessions()).filter((c) => c.agent.kind === 'codex')
  return {
    ...parts,
    codexCards,
    async cardOf(handle) {
      return (await codexCards()).find((c) => c.rooms.some((r) => r.handle === handle))
    },
    async bridgeLogTail(lines = 40) {
      const text = await Bun.file(live.bridgeLog)
        .text()
        .catch(() => '')
      return text.split('\n').slice(-lines).join('\n')
    },
    bridgePids: () => bridgePidsUnder(live.root),
    async close() {
      await this.rpc?.close().catch(() => undefined)
      await parts.bot.close().catch(() => undefined)
      await hub.stop().catch(() => undefined)
      await live.cleanup()
    },
  }
}
