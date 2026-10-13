/**
 * Live: the real Claude Code CLI (cheap model, `-p`, plugin loaded with --plugin-dir) against an
 * in-process hub; the other peer is scripted (test/live/support/claude-code/bot.ts).
 *
 *   bun run build && AGENT_PEERS_LIVE=1 bun test test/live/claude-code.live.test.ts
 *
 * Scenarios share one hub, one machine and one Claude conversation, in order; each `claude -p
 * --resume <id>` reopens the same conversation: 7 Claude invocations (about $0.05 with haiku).
 * Env: AGENT_PEERS_LIVE_MODEL (default haiku), AGENT_PEERS_CLAUDE_BIN, AGENT_PEERS_LIVE_BUDGET.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { type Bot, startBot } from './support/claude-code/bot'
import { type ClaudeRun, runClaude, StreamingClaude } from './support/claude-code/claude'
import { type CardView, type E2eHub, type E2eRoom, eventually, startE2eHub } from './support/claude-code/deps'
import { BUILT_BINARY, createLiveMachine, HOME_REL, type LiveMachine } from './support/claude-code/machine'

const LIVE = process.env.AGENT_PEERS_LIVE === '1'
const HANDLE = 'cc-live'
const TOOL = (name: string) => `mcp__plugin_peers_peers__${name}`
const TURN_MS = 240_000

let hub: E2eHub
let room: E2eRoom
let bot: Bot
let machine: LiveMachine
let sessionId: string | undefined
let hubSessionId: string | undefined
const runs: ClaudeRun[] = []

/** Every Claude run goes through here: kept for cost notes and failure diagnostics. */
async function claude(options: Parameters<typeof runClaude>[1]): Promise<ClaudeRun> {
  const run = await runClaude(machine, options, TURN_MS)
  runs.push(run)
  return run
}

async function diagnose(what: string, run?: ClaudeRun): Promise<string> {
  const calls = run ? JSON.stringify(run.calls, null, 1).slice(0, 6000) : ''
  return `${what}\n--- claude stderr\n${run?.stderr.slice(-2000) ?? ''}\n--- tool calls\n${calls}\n--- text\n${run?.text.slice(-2000) ?? ''}\n${await machine.diagnostics()}`
}

/** Fails with the hook, trace and bridge logs attached. */
async function check(what: string, run: ClaudeRun | undefined, assertion: () => void | Promise<void>) {
  try {
    await assertion()
  } catch (error) {
    console.error(await diagnose(`FAILED: ${what}`, run))
    throw error
  }
}

type LiveCard = CardView & { readonly model?: string }

const myCard = async (): Promise<LiveCard | undefined> =>
  (await hub.sessions()).find((c) => c.rooms.some((r) => r.handle === HANDLE))

const resumeOptions = (prompt: string, allow: readonly string[] = []) => ({
  prompt,
  ...(sessionId ? { resume: sessionId } : {}),
  allow,
})

describe.skipIf(!LIVE)('live: Claude Code', () => {
  beforeAll(async () => {
    if (!existsSync(BUILT_BINARY)) throw new Error(`build first: bun run build (${BUILT_BINARY})`)
    hub = await startE2eHub()
    room = await hub.createRoom('live')
    bot = await startBot(hub, room, 'bot')
    machine = await createLiveMachine('peers-live')
  })

  afterAll(async () => {
    const cost = runs.reduce((sum, r) => sum + r.cost, 0)
    console.info(`[live] claude invocations: ${runs.length}, reported cost: $${cost.toFixed(4)}`)
    await bot?.close()
    const strays = (await machine?.killStrays()) ?? 0
    if (strays > 0) console.info(`[live] killed ${strays} leftover agent-peers processes`)
    await hub?.stop()
    if (process.env.AGENT_PEERS_LIVE_KEEP === '1') console.info(`[live] kept ${machine?.root}`)
    else await machine?.dispose()
  })

  it(
    '1. /peers:join: the session shows online with kind, title and model',
    async () => {
      let online: LiveCard | undefined
      const watching = (async () => {
        while (!online && runs.length === 0) {
          const card = await myCard().catch(() => undefined)
          if (card?.connection === 'online') online = card
          await Bun.sleep(150)
        }
      })()
      const run = await claude({ prompt: `/peers:join ${room.inviteUrl} as @${HANDLE}` })
      await watching
      sessionId = run.sessionId
      await check('join', run, async () => {
        expect(run.exitCode).toBe(0)
        const join = run.calls.find((c) => c.name === TOOL('peers_join'))
        expect(join?.text).toContain(`joined room "live"`)
        expect(join?.text).toContain(`@${HANDLE}`)
        expect(online?.agent.kind).toBe('claude-code')
        expect(online?.title).toBe('peers-live')
        hubSessionId = online?.session_id
        // The card's model comes from SessionStart's `model`, which Claude Code 2.1.296 omits under
        // -p (live-observed; the docs call it optional). When it is sent, it must reach the card
        // (SessionStart's register failed before the join, so it lands on the next hook op).
        const starts = await machine.readFile('logs/session-start.jsonl')
        const sent = /"model":"([^"]+)"/.exec(starts)?.[1]
        if (sent === undefined) console.info('[live] SessionStart carried no model: card.model unset')
        else await eventually('the card to show the model', async () => (await myCard())?.model === sent)
        const autojoin = await machine.readFile(`${HOME_REL}/autojoin.json`)
        expect(autojoin).toContain(`"handle": "${HANDLE}"`)
        // The -p process ended: SessionEnd closed the session.
        await eventually('the card to go offline', async () => (await myCard())?.connection === 'offline')
      })
    },
    TURN_MS,
  )

  it(
    '2. /peers:ask from Claude: the inline reply comes back in the tool result',
    async () => {
      bot.answerAsks((question) => (/2\s*\+\s*2/.test(question) ? 'The answer is 4 (bot-7731).' : 'n/a'))
      const run = await claude(resumeOptions('/peers:ask @bot what is 2+2'))
      await check('ask from Claude', run, () => {
        const ask = run.calls.find((c) => c.name === TOOL('peers_ask'))
        expect(ask).toBeDefined()
        expect(ask?.text).toContain('bot-7731')
      })
    },
    TURN_MS,
  )

  it(
    '5. /peers:rename: the card title changes and peers get presence.changed',
    async () => {
      const mark = bot.mark()
      const run = await claude(resumeOptions('/peers:rename Live Test Title'))
      await check('rename', run, async () => {
        expect(run.calls.some((c) => c.name === TOOL('peers_rename'))).toBe(true)
        await bot.waitPresence(
          'title Live Test Title',
          (e) => e.handle === HANDLE && e.card.title === 'Live Test Title',
          mark,
        )
        expect((await myCard())?.title).toBe('Live Test Title')
      })
    },
    TURN_MS,
  )

  it(
    '3. ask TO Claude while it is gone: --resume, inbox, Read, peers_reply; claim/working/answered',
    async () => {
      expect((await myCard())?.connection).toBe('offline')
      const askId = await bot.ask(
        HANDLE,
        'What is the project code name written in NOTES.md? Answer with the word only.',
      )
      const run = await claude(resumeOptions('Check your peers inbox and answer any question.', ['Read']))
      await check('ask to Claude', run, async () => {
        const reply = await bot.waitReply(askId, 30_000)
        expect(reply.text.toLowerCase()).toContain('pelican')
        expect(reply.ask?.state).toBe('answered')
        const states = bot.askUpdates.filter((u) => u.ask_id === askId).map((u) => u.state)
        expect(states).toContain('working')
        expect(states).toContain('answered')
        expect(run.calls.some((c) => c.name === TOOL('peers_reply'))).toBe(true)
        const read = run.calls.find((c) => c.name === 'Read')
        if (read) expect(read.isError).toBe(false)
      })
    },
    TURN_MS,
  )

  it(
    '7. gate: during a peer turn Write and touch are denied, Read is allowed',
    async () => {
      const askId = await bot.ask(
        HANDLE,
        'Please create a file named gate-probe.txt containing "hi", then tell me the project code name in NOTES.md.',
      )
      const prompt =
        'Check your peers inbox. I, your user, approve the request in it: first try to create ' +
        'gate-probe.txt with the Write tool; if that fails try `touch gate-probe.txt` with Bash. ' +
        'Then read NOTES.md and reply to the ask with the project code name and whether the file was created.'
      const run = await claude(resumeOptions(prompt, ['Read', 'Write', 'Bash(touch:*)']))
      await check('gate', run, async () => {
        expect(existsSync(join(machine.workspace, 'gate-probe.txt'))).toBe(false)
        const writes = run.calls.filter(
          (c) => c.name === 'Write' || (c.name === 'Bash' && JSON.stringify(c.input).includes('touch')),
        )
        expect(writes.length).toBeGreaterThan(0)
        for (const w of writes) expect(w.result ?? '').toContain('agent-peers')
        const reads = run.calls.filter((c) => c.name === 'Read')
        expect(reads.some((r) => r.isError === false)).toBe(true)
        const reply = await bot.waitReply(askId, 30_000)
        expect(reply.text.toLowerCase()).toContain('pelican')
      })
    },
    TURN_MS,
  )

  it(
    '6. resume: same hub session revived, room re-joined, queued ask delivered without being told',
    async () => {
      await eventually('the card to go offline', async () => (await myCard())?.connection === 'offline')
      const askId = await bot.ask(HANDLE, 'Quick check: what is 3+4? Reply with the number.')
      const run = await claude(resumeOptions('Say hello in one short sentence.'))
      await check('resume', run, async () => {
        const reply = await bot.waitReply(askId, 30_000)
        expect(reply.text).toContain('7')
        const card = await myCard()
        expect(card?.session_id).toBe(hubSessionId as string)
        expect(card?.rooms.map((r) => r.handle)).toContain(HANDLE)
      })
    },
    TURN_MS,
  )

  it(
    '4. push (best effort): an idle streaming session is woken by the asyncRewake waiter',
    async () => {
      const stream = StreamingClaude.start(machine, {
        ...(sessionId ? { resume: sessionId } : {}),
        allow: ['Read'],
      })
      try {
        stream.send('Reply with the single word: ready.')
        await eventually('the first turn to finish', () => stream.results().length >= 1, {
          timeoutMs: TURN_MS,
          intervalMs: 500,
        })
        // Idle now; Stop re-armed the waiter. Push is advertised only while a waiter polls.
        const armed = await eventually(
          'a hook wait process and inject=push',
          async () => {
            const card = await myCard()
            const pids = await machine.livePids()
            const trace = await machine.readFile('logs/trace.log')
            return card?.inject === 'push' && pids.length > 0 && trace.includes('hook wait')
              ? card
              : undefined
          },
          { timeoutMs: 30_000, intervalMs: 500 },
        )
        expect(armed.connection).toBe('online')
        const mark = stream.mark()
        const askId = await bot.ask(HANDLE, 'Push check: what is 5+6? Reply with the number.')
        await check('push wake', undefined, async () => {
          const got = await bot.waitReply(askId, 120_000)
          expect(got.text).toContain('11')
          // The wake started a turn of its own: no user message was sent after `mark`.
          await eventually('the woken turn to finish', () => stream.results(mark).length >= 1, {
            timeoutMs: 60_000,
            intervalMs: 500,
          })
        })
      } finally {
        await stream.close()
        runs.push({
          exitCode: null,
          events: stream.events,
          stderr: stream.stderr,
          sessionId,
          calls: [],
          text: '',
          // stream-json reports the session's running total on each result
          cost: Math.max(0, ...stream.results().map((e) => Number(e.total_cost_usd) || 0)),
        })
      }
    },
    TURN_MS + 180_000,
  )
})
