/**
 * A scripted peer (no second paid agent): a plain protocol client with its own member, sitting in
 * the room as @<handle>. It records what a room member sees (messages, presence, ask states), can
 * ask other handles, and can answer asks addressed to it the way a bridge would (claim, then reply).
 */
import { type E2eHub, type E2eRoom, eventually, HubClient, type NotificationMap, SessionHandle } from './deps'

type Message = NotificationMap['msg.new']['message']
export type PresenceEvent = NotificationMap['presence.changed']
export type AskUpdate = NotificationMap['ask.updated']

export interface Bot {
  readonly handle: string
  readonly messages: readonly Message[]
  readonly presence: readonly PresenceEvent[]
  readonly askUpdates: readonly AskUpdate[]
  /** Sends an ask to @to; returns its ask_id. */
  ask(to: string, text: string): Promise<string>
  /** Answers every ask addressed to this bot (claim, then reply) with `answer(question)`. */
  answerAsks(answer: (question: string) => string): void
  /** The reply message to `askId`, once it arrived. */
  waitReply(askId: string, timeoutMs?: number): Promise<Message>
  waitAskState(askId: string, state: string, timeoutMs?: number): Promise<AskUpdate>
  waitPresence(
    what: string,
    match: (e: PresenceEvent) => boolean,
    after?: number,
    timeoutMs?: number,
  ): Promise<PresenceEvent>
  mark(): number
  close(): Promise<void>
}

export async function startBot(hub: E2eHub, room: E2eRoom, handle: string): Promise<Bot> {
  const client = new HubClient({
    bridge: { agent_kind: 'other', agent_version: '1.0.0', adapter: '0.1.0', host: 'bot-host' },
    heartbeatMs: 60_000,
  })
  const session = new SessionHandle(client, {
    localKey: `${handle}-bot`,
    card: { agent: { kind: 'other', adapter: '0.1.0' }, host: 'bot-host' },
  })
  let messages: readonly Message[] = []
  let presence: readonly PresenceEvent[] = []
  let askUpdates: readonly AskUpdate[] = []
  let answerer: ((question: string) => string) | undefined
  const answered = new Set<string>()

  const answer = async (message: Message) => {
    if (!answerer || answered.has(message.id)) return
    answered.add(message.id)
    await session.claim(message.id)
    await session.reply({ ask_id: message.id, text: answerer(message.text) })
  }

  session.on('msg.new', ({ message }) => {
    messages = [...messages, message]
    if (message.kind === 'ask' && message.to.includes(handle)) void answer(message).catch(() => undefined)
  })
  session.on('presence.changed', (event) => {
    presence = [...presence, event]
  })
  session.on('ask.updated', (event) => {
    askUpdates = [...askUpdates, event]
  })
  await client.connect(hub.url, hub.hub.services.members.create(`${handle}-member`).token)
  await session.open()
  await session.join({ invite_code: room.inviteUrl.split('/').at(-1) ?? '', handle })

  return {
    handle,
    get messages() {
      return messages
    },
    get presence() {
      return presence
    },
    get askUpdates() {
      return askUpdates
    },
    async ask(to, text) {
      const sent = await session.ask({ room_id: room.roomId, to, text })
      return sent.id
    },
    answerAsks(fn) {
      answerer = fn
      for (const m of messages)
        if (m.kind === 'ask' && m.to.includes(handle)) void answer(m).catch(() => undefined)
    },
    waitReply: (askId, timeoutMs = 120_000) =>
      eventually(`a reply to ${askId}`, () => messages.find((m) => m.kind === 'reply' && m.re === askId), {
        timeoutMs,
        intervalMs: 200,
      }),
    waitAskState: (askId, state, timeoutMs = 120_000) =>
      eventually(
        `ask ${askId} → ${state}`,
        () => askUpdates.find((u) => u.ask_id === askId && u.state === state),
        { timeoutMs, intervalMs: 200 },
      ),
    waitPresence: (what, match, after = 0, timeoutMs = 60_000) =>
      eventually(`presence: ${what}`, () => presence.slice(after).find(match), {
        timeoutMs,
        intervalMs: 200,
      }),
    mark: () => presence.length,
    async close() {
      session.dispose()
      await client.close('live test done').catch(() => undefined)
    },
  }
}
