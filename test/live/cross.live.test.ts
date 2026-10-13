/**
 * Cross-agent live suite (AGENT_PEERS_LIVE=1): a real Claude Code (@cc, haiku) and a real Codex
 * (@cx, cheap model, low effort) in one room of one in-process hub. Neither knows the other's files,
 * so each answer can only come from the other agent:
 *
 *   1. Claude joins and asks @cx for PORT in Codex's config.txt; the idle Codex thread is woken
 *      (`codex queue`), reads the file and replies; Claude receives the reply.
 *   2. Codex asks @cc for VERSION in Claude's version.txt; the idle Claude is woken (asyncRewake
 *      waiter), reads the file and replies; Codex receives the reply.
 *   3. Codex renames its card title; Claude sees the new title through peers_who.
 *
 *   bun run build && AGENT_PEERS_LIVE=1 bun test test/live/cross.live.test.ts
 *
 * Budget: 3 Claude turns in one streaming process + 4 Codex turns (one of them pushed), plus at most
 * one more on either side if an inline ask times out and the reply is injected later.
 * Knobs: AGENT_PEERS_LIVE_MODEL / AGENT_PEERS_CLAUDE_BIN (Claude), CODEX_LIVE_MODEL /
 * CODEX_LIVE_EFFORT / CODEX_LIVE_BIN (Codex), AGENT_PEERS_LIVE_KEEP=1 / CODEX_LIVE_KEEP=1 (keep temp dirs).
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { type StreamEvent, toolCalls } from './support/claude-code/claude'
import { type CardView, eventually } from './support/claude-code/deps'
import { codexLivePrereqs } from './support/codex-env'
import { describeTurn, runTurn, toolCall, turnBudget, waitForPushedTurn } from './support/codex-thread'
import { type CrossWorld, createCrossWorld, PORT_VALUE, VERSION_VALUE } from './support/cross-world'

const LIVE = process.env.AGENT_PEERS_LIVE === '1'
const missing = LIVE ? codexLivePrereqs() : undefined
if (LIVE && missing) process.stderr.write(`[cross-live] skipped: ${missing}\n`)

const CC = 'cc'
const CX = 'cx'
const CX_TITLE = 'Cross Codex'
const CC_TOOL = (name: string) => `mcp__plugin_peers_peers__${name}`
const TURN_MS = 240_000

let w: CrossWorld

const cardOf = async (handle: string): Promise<CardView | undefined> =>
  (await w.hub.sessions()).find((c) => c.rooms.some((r) => r.handle === handle))

const claudeEvents = (after: number): readonly StreamEvent[] => w.claude.events.slice(after)
const claudeCall = (after: number, tool: string) =>
  toolCalls(claudeEvents(after)).find((c) => c.name === CC_TOOL(tool))

/** Sends one user message to the streaming Claude and waits for that turn's `result`. */
async function claudeTurn(text: string): Promise<number> {
  const mark = w.claude.mark()
  w.claude.send(text)
  await eventually('the Claude turn to finish', () => w.claude.results(mark).length >= 1, {
    timeoutMs: TURN_MS,
    intervalMs: 500,
  })
  return mark
}

async function diagnostics(): Promise<string> {
  const calls = toolCalls(w.claude.events).map((c) => `${c.name} → ${(c.text ?? '').slice(0, 300)}`)
  const bridge = await Bun.file(w.codex.bridgeLog)
    .text()
    .catch(() => '')
  return [
    `--- claude tool calls\n${calls.join('\n')}`,
    `--- claude stderr\n${w.claude.stderr.slice(-2000)}`,
    await w.machine.diagnostics(),
    `--- codex bridge log\n${bridge.split('\n').slice(-40).join('\n')}`,
    `--- cards\n${JSON.stringify(await w.hub.sessions().catch(() => []), null, 1).slice(0, 4000)}`,
  ].join('\n')
}

async function check(what: string, assertion: () => Promise<void>): Promise<void> {
  try {
    await assertion()
  } catch (error) {
    console.error(`FAILED: ${what}\n${await diagnostics()}`)
    throw error
  }
}

describe.skipIf(!LIVE || missing !== undefined)('live: Claude Code ↔ Codex', () => {
  beforeAll(async () => {
    w = await createCrossWorld()
  }, 300_000)

  afterAll(async () => {
    if (!w) return
    const claudeTurns = w.claude.results().length
    const cost = Math.max(0, ...w.claude.results().map((e) => Number(e.total_cost_usd) || 0))
    w.note(`invocations: claude turns ${claudeTurns} ($${cost.toFixed(4)}), codex turns ${turnBudget.used}`)
    process.stderr.write(`[cross-live] REPORT\n${w.notes.map((n) => `  - ${n}`).join('\n')}\n`)
    await w.close()
  }, 120_000)

  it(
    '1. Claude asks @cx about a Codex file; the idle Codex is woken and replies; Claude gets the answer',
    async () => {
      const join = await runTurn(
        w.rpc,
        w.threadId,
        `Use the peers_join tool with invite ${w.room.inviteUrl} and handle ${CX}. Then reply "joined".`,
      )
      w.note(`codex join: ${describeTurn(join)}`)
      await check('codex join', async () => {
        expect(toolCall(join, 'peers_join')?.text).toContain(`@${CX}`)
        await eventually('@cx online and idle', async () => {
          const card = await cardOf(CX)
          return card?.connection === 'online' && card.activity === 'idle'
        })
      })

      const markX = w.rpc.mark()
      const question =
        'What is the value of PORT in config.txt in your workspace? Reply with the number only.'
      const asking = claudeTurn(
        `Use the peers_join tool with invite ${w.room.inviteUrl} and handle ${CC}. Then use the ` +
          `peers_ask tool to ask @${CX} exactly this: "${question}" Finally tell me the answer in one line.`,
      )
      asking.catch(() => undefined) // awaited below; keeps an early failure from going unhandled
      await check('codex woken by the ask', async () => {
        const pushed = await waitForPushedTurn(w.rpc, w.threadId, markX, 180_000)
        w.note(`codex woken: ${describeTurn(pushed)}`)
        expect(toolCall(pushed, 'peers_reply')?.status).toBe('completed')
      })
      const markC = await asking
      await check('claude receives the reply', async () => {
        const card = await cardOf(CC)
        expect(card?.agent.kind).toBe('claude-code')
        const ask = claudeCall(markC, 'peers_ask')
        expect(ask).toBeDefined()
        const inline = (ask?.text ?? '').includes(PORT_VALUE)
        w.note(
          `claude ask: ${inline ? 'reply inline in peers_ask' : `not inline: ${ask?.text?.slice(0, 200)}`}`,
        )
        if (!inline)
          await eventually(
            'the reply to reach Claude later',
            () => JSON.stringify(claudeEvents(markC)).includes(PORT_VALUE),
            { timeoutMs: 120_000, intervalMs: 500 },
          )
        const sent = (await w.hub.messages(w.room.roomId)).find((m) => m.kind === 'ask' && m.to.includes(CX))
        expect(sent?.ask?.state).toBe('answered')
      })
    },
    TURN_MS * 2,
  )

  it(
    '2. Codex asks @cc about a Claude file; the idle Claude is woken and replies; Codex gets the answer',
    async () => {
      await check('claude armed for push', async () => {
        await eventually('@cc to advertise push', async () => (await cardOf(CC))?.inject === 'push', {
          timeoutMs: 30_000,
          intervalMs: 500,
        })
      })
      const markC = w.claude.mark()
      const markX = w.rpc.mark()
      const question =
        'What is the value of VERSION in version.txt in your workspace? Reply with the value only.'
      const turn = await runTurn(
        w.rpc,
        w.threadId,
        `Use the peers_ask tool to ask @${CC} exactly this: "${question}" Then tell me the answer in one line.`,
      )
      const afterTurn = w.rpc.mark()
      w.note(`codex ask: ${describeTurn(turn)}`)
      const seen = (after: number) =>
        JSON.stringify(w.rpc.notifications.slice(after)).toLowerCase().includes(VERSION_VALUE)
      await check('codex receives the reply', async () => {
        const ask = toolCall(turn, 'peers_ask')
        expect(ask?.status).toBe('completed')
        const inline = (ask?.text ?? '').toLowerCase().includes(VERSION_VALUE)
        w.note(
          `codex ask: ${inline ? 'reply inline in peers_ask' : `not inline: ${ask?.text.slice(0, 200)}`}`,
        )
        // Not inline: the reply is delivered later, by Stop's decision:block in the same turn or by
        // `codex queue` in a new one.
        if (!inline && !seen(markX)) {
          const later = await waitForPushedTurn(w.rpc, w.threadId, afterTurn, 120_000)
          w.note(`codex got the reply in a later turn: ${describeTurn(later)}`)
          expect(seen(afterTurn)).toBe(true)
        }
      })
      await check('claude woken without a user message', async () => {
        await eventually('the woken Claude turn to finish', () => w.claude.results(markC).length >= 1, {
          timeoutMs: 60_000,
          intervalMs: 500,
        })
        const calls = toolCalls(claudeEvents(markC))
        expect(calls.some((c) => c.name === CC_TOOL('peers_reply'))).toBe(true)
        expect(calls.some((c) => c.name === 'Read' && c.isError === false)).toBe(true)
        w.note(
          `claude woken: tools ${calls.map((c) => c.name.replace('mcp__plugin_peers_peers__', '')).join(', ')}`,
        )
      })
    },
    TURN_MS * 2,
  )

  it(
    '3. Codex renames its title; Claude sees the new title via peers_who',
    async () => {
      const turn = await runTurn(
        w.rpc,
        w.threadId,
        `Use the peers_rename tool with title "${CX_TITLE}" (keep the handle). Then reply "renamed".`,
      )
      w.note(`codex rename: ${describeTurn(turn)}`)
      await check('rename on the hub', async () => {
        expect(toolCall(turn, 'peers_rename')?.status).toBe('completed')
        await eventually('the @cx card title', async () => (await cardOf(CX))?.title === CX_TITLE)
      })
      const mark = await claudeTurn(`Use the peers_who tool and tell me the card title shown for @${CX}.`)
      await check('claude sees the title', async () => {
        const who = claudeCall(mark, 'peers_who')
        expect(who?.text).toContain(CX_TITLE)
        w.note(`claude peers_who: ${(who?.text ?? '').split('\n').find((l) => l.includes(CX_TITLE)) ?? ''}`)
      })
    },
    TURN_MS,
  )
})
