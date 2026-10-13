/**
 * Codex live suite (AGENT_PEERS_LIVE=1): a real Codex CLI (cheap model, low effort) with the peers
 * plugin installed into a temp CODEX_HOME by `agent-peers add -a codex -y`, driven over
 * `codex app-server` JSON-RPC through the temp CODEX_HOME's shared daemon, against an in-process hub
 * and a scripted bot written with @agent-peers/core. What each scenario proves, and the
 * mechanisms it verified on codex-cli 0.160.1, is in adapters/codex/README.md ("Live-verified").
 *
 *   bun run build && AGENT_PEERS_LIVE=1 bun test test/live/codex.live.test.ts
 *
 * Knobs: CODEX_LIVE_MODEL (gpt-6-luna), CODEX_LIVE_EFFORT (low), CODEX_LIVE_MAX_TURNS (25),
 * CODEX_LIVE_BIN (Codex CLI), CODEX_LIVE_KEEP=1 (keep the temp root for debugging).
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { existsSync } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { codexLivePrereqs, stopDaemon } from './support/codex-env'
import { execResume } from './support/codex-exec'
import {
  describeTurn,
  LIVE_EFFORT,
  LIVE_MODEL,
  runTurn,
  startThread,
  type TurnSummary,
  toolCall,
  turnBudget,
  waitForPushedTurn,
} from './support/codex-thread'
import { BOT_ANSWER, type CodexWorld, createCodexWorld, waitUntil } from './support/codex-world'

const LIVE = process.env.AGENT_PEERS_LIVE === '1'
const missing = LIVE ? codexLivePrereqs() : undefined
if (LIVE && missing) process.stderr.write(`[codex-live] skipped: ${missing}\n`)

let w: CodexWorld
const state: { threadA?: string; threadB?: string; sessionA?: string } = {}

const rpc = () => {
  if (!w.rpc) throw new Error('no app-server connection')
  return w.rpc
}
const log = (turn: TurnSummary): TurnSummary => {
  w.note(describeTurn(turn))
  return turn
}
const needA = (): string => {
  if (!state.threadA) throw new Error('thread A was not started (an earlier scenario failed)')
  return state.threadA
}

describe.skipIf(!LIVE || missing !== undefined)('live: Codex CLI', () => {
  beforeAll(async () => {
    w = await createCodexWorld()
    w.note(`model ${LIVE_MODEL}, effort ${LIVE_EFFORT}`)
  }, 300_000)

  afterAll(async () => {
    if (!w) return
    w.note(`model turns used: ${turnBudget.used}`)
    process.stderr.write(`[codex-live] bridge log tail:\n${await w.bridgeLogTail(25)}\n`)
    process.stderr.write(`[codex-live] REPORT\n${w.notes.map((n) => `  - ${n}`).join('\n')}\n`)
    await w.close()
  }, 60_000)

  it('1. joins from natural language; the hub shows a codex session with a truthful tier', async () => {
    state.threadA = await startThread(rpc(), w.workspaces.a)
    const turn = log(
      await runTurn(
        rpc(),
        state.threadA,
        `Use the peers_join tool with invite ${w.room.inviteUrl} and handle cx-live. Then reply "joined".`,
      ),
    )
    expect(toolCall(turn, 'peers_join')?.text).toContain('@cx-live')
    expect(turn.hooks.filter((h) => h.status !== 'completed')).toEqual([])
    const card = await waitUntil('the cx-live card to be online and hooked', async () => {
      const c = await w.cardOf('cx-live')
      return c?.connection === 'online' && c.inject !== 'poll' ? c : undefined
    })
    state.sessionA = card.session_id
    w.note(`join: card agent=${card.agent.kind} inject=${card.inject} activity=${card.activity}`)
    // Push is claimed only after a `codex queue` reached this thread (ARCHITECTURE §6.2).
    expect(card.inject).toBe('boundary')
    // mcp.json env_vars reach the bridge: AGENT_PEERS_BIN (the logged wrapper, whose `2>>` creates
    // bridge.log; the pinned shim default would not) and the non-default AGENT_PEERS_HOME.
    // (Codex hooks are mcp_tool calls, so there is no control socket: the join's autojoin.json is
    // the bridge state to look for.)
    expect(existsSync(w.live.bridgeLog)).toBe(true)
    const files = await readdir(w.live.peersHome).catch(() => [] as string[])
    expect(files).toContain('autojoin.json')
    expect(existsSync(join(w.live.home, '.agent-peers'))).toBe(false)
    w.note(`env_vars: bridge.log written; AGENT_PEERS_HOME holds ${files.join(' ')}`)
  }, 240_000)

  it('2. asks the scripted bot from Codex and gets the reply inline in the tool result', async () => {
    const turn = log(
      await runTurn(
        rpc(),
        needA(),
        'Use the peers_ask tool to ask @bot: "What is the code word?" Then tell me the answer in one line.',
      ),
    )
    const ask = toolCall(turn, 'peers_ask')
    expect(ask?.status).toBe('completed')
    expect(ask?.text).toContain('PINEAPPLE-42')
    expect(w.bot.answered.length).toBeGreaterThanOrEqual(1)
    w.note(`ask from Codex: inline tool result contained "${BOT_ANSWER}"`)
  }, 240_000)

  it('3a. an ask TO an idle Codex thread is pushed with `codex queue` and answered with peers_reply', async () => {
    const threadId = needA()
    const mark = rpc().mark()
    const askId = await w.bot.ask(
      'cx-live',
      'Reply to this ask with the single word MANGO using peers_reply.',
    )
    const pushed = log(await waitForPushedTurn(rpc(), threadId, mark, 60_000))
    const reply = await w.bot.waitReply(askId, 120_000)
    expect(reply.text).toContain('MANGO')
    expect(toolCall(pushed, 'peers_reply')?.status).toBe('completed')
    expect(pushed.userTexts.join('\n')).toContain(askId)
    const card = await waitUntil('the card to advertise push', async () => {
      const c = await w.cardOf('cx-live')
      return c?.inject === 'push' ? c : undefined
    })
    w.note(`push: codex queue started turn ${pushed.turnId}; card inject=${card.inject}`)
  }, 240_000)

  it('4. renames the title and the handle; the hub and the bot see it', async () => {
    const turn = log(
      await runTurn(
        rpc(),
        needA(),
        'Use the peers_rename tool with handle "cx-renamed" and title "Live Codex". Reply "renamed".',
      ),
    )
    expect(toolCall(turn, 'peers_rename')?.text).toContain('@cx-renamed')
    const card = await waitUntil('the renamed card', async () => {
      const c = await w.cardOf('cx-renamed')
      return c?.title === 'Live Codex' ? c : undefined
    })
    expect(card.session_id).toBe(String(state.sessionA))
    // The room sees the new handle through presence.changed (handle.renamed goes to the session itself).
    const seen = await w.bot.waitEvent(
      'the bot to see @cx-renamed',
      (e): e is Extract<typeof e, { kind: 'presence' }> =>
        e.kind === 'presence' && e.event.handle === 'cx-renamed',
      15_000,
    )
    w.note(
      `rename: hub title="${card.title}", bot saw presence.changed for @${seen.event.handle} (title "${seen.event.card.title}")`,
    )
  }, 240_000)

  it('6. two threads in one app-server: an ask to the second handle runs in the second thread', async () => {
    state.threadB = await startThread(rpc(), w.workspaces.b)
    const join = log(
      await runTurn(
        rpc(),
        state.threadB,
        `Use the peers_join tool with invite ${w.room.inviteUrl} and handle cx-two. Then reply "joined".`,
      ),
    )
    expect(toolCall(join, 'peers_join')?.text).toContain('@cx-two')
    const two = await waitUntil('the cx-two card', async () => w.cardOf('cx-two'))
    expect(two.session_id).not.toBe(String(state.sessionA))
    w.note(`two threads: ${w.bridgePids().length} bridge process(es) for 2 threads in one daemon`)
    expect(w.bridgePids()).toHaveLength(2)
    await waitUntil(
      'thread B to be idle',
      async () => (await w.cardOf('cx-two'))?.activity === 'idle',
      30_000,
    )
    const mark = rpc().mark()
    const askId = await w.bot.ask('cx-two', 'Reply to this ask with the single word KIWI using peers_reply.')
    const pushed = log(await waitForPushedTurn(rpc(), state.threadB, mark, 60_000))
    expect((await w.bot.waitReply(askId, 120_000)).text).toContain('KIWI')
    const strayTurns = rpc()
      .notifications.slice(mark)
      .filter((n) => n.method === 'turn/started' && n.params.threadId === state.threadA)
    expect(strayTurns).toEqual([])
    w.note(`attribution: ask to @cx-two ran in thread B (turn ${pushed.turnId}), none in thread A`)
  }, 360_000)

  it('3b. an ask that arrives while Codex is busy is delivered at Stop (decision: block)', async () => {
    const threadId = needA()
    const mark = rpc().mark()
    const running = runTurn(
      rpc(),
      threadId,
      'Use the peers_who tool, then summarize the room in one short line.',
    )
    await rpc().waitFor(
      'UserPromptSubmit of the busy turn',
      (n) =>
        n.method === 'hook/completed' &&
        n.params.threadId === threadId &&
        (n.params.run as { eventName?: string }).eventName === 'userPromptSubmit',
      60_000,
      mark,
    )
    const askId = await w.bot.ask(
      'cx-renamed',
      'Reply to this ask with the single word PEAR using peers_reply.',
    )
    const turn = log(await running)
    const reply = await w.bot.waitReply(askId, 180_000)
    expect(reply.text).toContain('PEAR')
    const queuedTurns = rpc()
      .notifications.slice(mark)
      .filter((n) => n.method === 'turn/started' && n.params.threadId === threadId)
    w.note(
      `busy fallback: reply via ${toolCall(turn, 'peers_reply') ? 'the same turn (Stop block continuation)' : 'a later turn'}; ${queuedTurns.length} turn(s) started`,
    )
    // Stop's decision:block continued the busy turn itself: no second turn was queued for the ask.
    expect(toolCall(turn, 'peers_reply')?.status).toBe('completed')
    expect(queuedTurns).toHaveLength(1)
  }, 360_000)

  it('5. resume: `codex exec resume` revives the same session, re-claims the handle, gets the queued ask', async () => {
    const threadId = needA()
    await w.rpc?.close()
    w.rpc = undefined
    const stopped = await stopDaemon(w.live)
    w.note(`daemon stop: exit ${stopped.exitCode}`)
    await waitUntil('cx-renamed to go offline', async () => {
      const c = (await w.hub.sessions()).find((s) => s.session_id === state.sessionA)
      return c === undefined || c.connection !== 'online'
    })
    const askId = await w.bot.ask(
      'cx-renamed',
      'Reply to this ask with the single word PLUM using peers_reply.',
    )
    turnBudget.take('exec resume')
    const exec = await execResume(w.live, threadId, w.workspaces.a, 'Anything new from my peers? Handle it.')
    w.note(`exec resume: exit ${exec.exitCode}; tools: ${exec.tools.join(', ') || 'none'}`)
    const reply = await w.bot.waitReply(askId, 60_000)
    expect(reply.text).toContain('PLUM')
    // The same hub session was revived (equal local_key = thread id) and re-claimed @cx-renamed.
    expect(reply.from).toMatchObject({ handle: 'cx-renamed', session_id: state.sessionA })
  }, 300_000)
})
