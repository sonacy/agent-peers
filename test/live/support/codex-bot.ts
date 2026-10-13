/**
 * A scripted peer for the Codex live suite, written against @agent-peers/core (no agent, no bridge).
 * It joins the room, answers every ask addressed to it with a fixed text, asks other handles, and
 * records what it sees (messages, presence, renames) so the tests can assert what a peer observes.
 */
import { HubClient, type NotificationMap, SessionHandle } from '../../e2e/support/deps'
import type { E2eHub, E2eRoom } from '../../e2e/support/hub'

type Message = NotificationMap['msg.new']['message']
export type BotEvent =
  | { readonly kind: 'msg'; readonly message: Message }
  | { readonly kind: 'presence'; readonly event: NotificationMap['presence.changed'] }
  | { readonly kind: 'renamed'; readonly event: NotificationMap['handle.renamed'] }
  | { readonly kind: 'ask'; readonly event: NotificationMap['ask.updated'] }

export interface Bot {
  readonly handle: string
  readonly events: readonly BotEvent[]
  /** Questions this bot answered: the ask text it received. */
  readonly answered: readonly string[]
  ask(to: string, text: string): Promise<string>
  /** Waits for the reply to `askId` (kind `reply`, `re` = askId). */
  waitReply(askId: string, timeoutMs: number): Promise<Message>
  waitEvent<T extends BotEvent>(what: string, match: (e: BotEvent) => e is T, timeoutMs: number): Promise<T>
  close(): Promise<void>
}

export interface BotOptions {
  readonly hub: E2eHub
  readonly room: E2eRoom
  readonly handle: string
  /** The answer to every ask addressed to this bot. */
  readonly answer: string
}

async function poll<T>(what: string, probe: () => T | undefined, timeoutMs: number): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = probe()
    if (value !== undefined) return value
    if (Date.now() > deadline) throw new Error(`timed out after ${timeoutMs} ms waiting for ${what}`)
    await Bun.sleep(100)
  }
}

export async function startBot(options: BotOptions): Promise<Bot> {
  const client = new HubClient({
    bridge: { agent_kind: 'other', agent_version: '1.0.0', adapter: '0.1.0', host: 'bot-host' },
    heartbeatMs: 15_000,
  })
  const session = new SessionHandle(client, {
    localKey: `${options.handle}-bot`,
    card: { agent: { kind: 'other', adapter: '0.1.0' }, host: 'bot-host', title: 'scripted bot' },
  })
  let events: readonly BotEvent[] = []
  let answered: readonly string[] = []
  const push = (event: BotEvent) => {
    events = [...events, event]
  }
  const answer = async (message: Message) => {
    if (message.kind !== 'ask' || !message.to.includes(options.handle)) return
    try {
      await session.claim(message.id)
      await session.reply({ ask_id: message.id, text: options.answer })
      answered = [...answered, message.text]
    } catch (error) {
      process.stderr.write(`bot: could not answer ${message.id}: ${String(error)}\n`)
    }
  }
  session.on('msg.new', (n) => {
    push({ kind: 'msg', message: n.message })
    void answer(n.message)
  })
  session.on('presence.changed', (event) => push({ kind: 'presence', event }))
  session.on('handle.renamed', (event) => push({ kind: 'renamed', event }))
  session.on('ask.updated', (event) => push({ kind: 'ask', event }))
  await client.connect(options.hub.url, options.hub.hub.services.members.create(options.handle).token)
  await session.open()
  const code = options.room.inviteUrl.split('/').at(-1) ?? ''
  await session.join({ invite_code: code, handle: options.handle })
  return {
    handle: options.handle,
    get events() {
      return events
    },
    get answered() {
      return answered
    },
    async ask(to, text) {
      const sent = await session.ask({ room_id: options.room.roomId, to: to.replace(/^@/, ''), text })
      return sent.id
    },
    waitReply: (askId, timeoutMs) =>
      poll(
        `the reply to ${askId}`,
        () =>
          events.flatMap((e) =>
            e.kind === 'msg' && e.message.kind === 'reply' && e.message.re === askId ? [e.message] : [],
          )[0],
        timeoutMs,
      ),
    waitEvent: (what, match, timeoutMs) => poll(what, () => events.find(match), timeoutMs),
    async close() {
      session.dispose()
      await client.close('live test done')
    },
  }
}
