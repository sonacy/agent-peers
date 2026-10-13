/**
 * The fixture of the cross-agent live suite: one in-process hub and one room, a real Claude Code
 * machine (test/live/support/claude-code) and a real Codex install (test/live/support/codex-*), each
 * with its own workspace and AGENT_PEERS_HOME, so they meet only through the hub.
 *
 *   Claude workspace: version.txt (VERSION=7.3.9), the file Codex asks about. (Not NOTES.md: an earlier
 *                     fixture called its value a "secret word", and a model may rightly refuse to hand a peer that.)
 *   Codex workspace:  config.txt (PORT=4817), the file Claude asks about.
 *
 * Claude runs as one streaming `claude -p` process (stdin held open), so an idle Claude is woken by
 * its asyncRewake waiter; Codex runs in a thread hosted by the temp CODEX_HOME's daemon, so an idle
 * Codex is woken by `codex queue`.
 */
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { StreamingClaude } from './claude-code/claude'
import { type E2eHub, type E2eRoom, startE2eHub } from './claude-code/deps'
import { createLiveMachine, type LiveMachine } from './claude-code/machine'
import { type CodexLiveEnv, createCodexEnv } from './codex-env'
import type { CodexRpc } from './codex-rpc'
import { approvePeersOnly, startThread } from './codex-thread'
import { prepareCodex } from './codex-world'

export const PORT_VALUE = '4817'
export const VERSION_VALUE = '7.3.9'

export interface CrossWorld {
  readonly hub: E2eHub
  readonly room: E2eRoom
  readonly machine: LiveMachine
  readonly claude: StreamingClaude
  readonly codex: CodexLiveEnv
  readonly rpc: CodexRpc
  readonly threadId: string
  readonly codexWorkspace: string
  readonly notes: string[]
  note(line: string): void
  close(): Promise<void>
}

interface Parts {
  hub?: E2eHub
  machine?: LiveMachine
  claude?: StreamingClaude
  codex?: CodexLiveEnv
  rpc?: CodexRpc
}

const keep = () => process.env.AGENT_PEERS_LIVE_KEEP === '1'

/** Stops everything that was started, in reverse order; never throws. */
async function teardown(parts: Parts, note: (line: string) => void): Promise<void> {
  const step = async (what: string, run: () => Promise<unknown>) => {
    try {
      await run()
    } catch (error) {
      note(`cleanup ${what}: ${String(error)}`)
    }
  }
  await step('claude', async () => parts.claude?.close())
  await step('claude strays', async () => {
    const strays = (await parts.machine?.killStrays()) ?? 0
    if (strays > 0) note(`killed ${strays} leftover agent-peers processes (Claude side)`)
  })
  await step('codex rpc', async () => parts.rpc?.close())
  await step('codex env', async () => parts.codex?.cleanup())
  await step('hub', async () => parts.hub?.stop())
  if (keep()) note(`kept ${parts.machine?.root}`)
  else await step('machine', async () => parts.machine?.dispose())
}

export async function createCrossWorld(): Promise<CrossWorld> {
  const notes: string[] = []
  const note = (line: string) => {
    notes.push(line)
    process.stderr.write(`[cross-live] ${line}\n`)
  }
  const parts: Parts = {}
  try {
    parts.hub = await startE2eHub()
    const room = await parts.hub.createRoom('cross')
    parts.codex = await createCodexEnv()
    const codexWorkspace = await parts.codex.workspace('ws-cx')
    await writeFile(
      join(codexWorkspace, 'config.txt'),
      `# service config\nHOST=0.0.0.0\nPORT=${PORT_VALUE}\n`,
    )
    await prepareCodex(parts.codex, codexWorkspace, note)
    parts.rpc = await parts.codex.appServer('daemon', codexWorkspace, approvePeersOnly)
    const threadId = await startThread(parts.rpc, codexWorkspace)
    parts.machine = await createLiveMachine('cc-ws')
    await writeFile(join(parts.machine.workspace, 'version.txt'), `VERSION=${VERSION_VALUE}\n`)
    parts.claude = StreamingClaude.start(parts.machine, { allow: ['Read'] })
    const { hub, machine, claude, codex, rpc } = parts
    return {
      hub,
      room,
      machine,
      claude,
      codex,
      rpc,
      threadId,
      codexWorkspace,
      notes,
      note,
      close: () => teardown(parts, note),
    }
  } catch (error) {
    await teardown(parts, note)
    throw error
  }
}
