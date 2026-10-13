/**
 * Thread and turn helpers over a Codex app-server connection: start threads, run a turn and wait
 * for it, notice turns this client did not start (a `codex queue` push), and summarize what
 * happened in a turn (user input, MCP tool calls, agent messages, hook runs).
 *
 * Every model turn counts against a hard budget (`CODEX_LIVE_MAX_TURNS`, default 25) so a broken
 * scenario cannot burn tokens in a loop.
 */
import type { CodexRpc, Notification, ServerRequestPolicy } from './codex-rpc'

export const LIVE_MODEL = process.env.CODEX_LIVE_MODEL?.trim() || 'gpt-6-luna'
export const LIVE_EFFORT = process.env.CODEX_LIVE_EFFORT?.trim() || 'low'
export const MAX_TURNS = Number(process.env.CODEX_LIVE_MAX_TURNS ?? 25)
export const TURN_TIMEOUT_MS = 180_000

export interface ToolCall {
  readonly server: string
  readonly tool: string
  readonly status: string
  readonly arguments: Record<string, unknown>
  readonly text: string
}

export interface TurnSummary {
  readonly threadId: string
  readonly turnId: string
  readonly status: string
  readonly userTexts: readonly string[]
  readonly toolCalls: readonly ToolCall[]
  readonly messages: readonly string[]
  readonly hooks: readonly { readonly event: string; readonly status: string }[]
}

const record = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {}

const resultText = (result: unknown): string =>
  ((record(result).content as unknown[] | undefined) ?? [])
    .map((c) => String(record(c).text ?? ''))
    .join('\n')

/** The "user" of the live suite: approves the peers MCP tools Codex asks about, declines the rest. */
export const approvePeersOnly: ServerRequestPolicy = (method, params) => {
  if (method === 'mcpServer/elicitation/request')
    return params.serverName === 'peers' ? { action: 'accept', content: {} } : { action: 'decline' }
  if (method === 'item/commandExecution/requestApproval' || method === 'item/fileChange/requestApproval')
    return { decision: 'decline' }
  return undefined
}

let turnsUsed = 0
export const turnBudget = {
  get used(): number {
    return turnsUsed
  },
  take(what: string): void {
    if (turnsUsed >= MAX_TURNS) throw new Error(`turn budget (${MAX_TURNS}) exhausted before: ${what}`)
    turnsUsed += 1
  },
}

const inTurn = (n: Notification, threadId: string, turnId: string): boolean =>
  n.params.threadId === threadId && n.params.turnId === turnId

function itemsOf(rpc: CodexRpc, threadId: string, turnId: string): readonly Record<string, unknown>[] {
  return rpc.notifications
    .filter((n) => n.method === 'item/completed' && inTurn(n, threadId, turnId))
    .map((n) => record(n.params.item))
}

export function summarize(rpc: CodexRpc, threadId: string, turnId: string): TurnSummary {
  const items = itemsOf(rpc, threadId, turnId)
  const completed = rpc.notifications.find(
    (n) =>
      n.method === 'turn/completed' && n.params.threadId === threadId && record(n.params.turn).id === turnId,
  )
  const hooks = rpc.notifications
    .filter((n) => n.method === 'hook/completed' && inTurn(n, threadId, turnId))
    .map((n) => ({
      event: String(record(n.params.run).eventName),
      status: String(record(n.params.run).status),
    }))
  return {
    threadId,
    turnId,
    status: completed ? String(record(completed.params.turn).status) : 'running',
    userTexts: items
      .filter((i) => i.type === 'userMessage')
      .flatMap((i) => ((i.content as unknown[]) ?? []).map((c) => String(record(c).text ?? ''))),
    toolCalls: items
      .filter((i) => i.type === 'mcpToolCall')
      .map((i) => ({
        server: String(i.server),
        tool: String(i.tool),
        status: String(i.status),
        arguments: record(i.arguments),
        text: resultText(i.result) || JSON.stringify(i.error ?? null),
      })),
    messages: items.filter((i) => i.type === 'agentMessage').map((i) => String(i.text ?? '')),
    hooks,
  }
}

export async function startThread(rpc: CodexRpc, cwd: string): Promise<string> {
  const started = await rpc.request<{ thread: { id: string } }>('thread/start', {
    cwd,
    model: LIVE_MODEL,
    approvalPolicy: 'on-request',
    sandbox: 'read-only',
  })
  return started.thread.id
}

async function waitCompleted(
  rpc: CodexRpc,
  threadId: string,
  turnId: string,
  after: number,
): Promise<TurnSummary> {
  await rpc.waitFor(
    `turn ${turnId} to complete`,
    (n) =>
      n.method === 'turn/completed' && n.params.threadId === threadId && record(n.params.turn).id === turnId,
    TURN_TIMEOUT_MS,
    after,
  )
  return summarize(rpc, threadId, turnId)
}

/** Sends one user prompt and waits for the turn to finish. */
export async function runTurn(rpc: CodexRpc, threadId: string, text: string): Promise<TurnSummary> {
  turnBudget.take(text.slice(0, 60))
  const mark = rpc.mark()
  const started = await rpc.request<{ turn: { id: string } }>('turn/start', {
    threadId,
    effort: LIVE_EFFORT,
    input: [{ type: 'text', text, text_elements: [] }],
  })
  return waitCompleted(rpc, threadId, started.turn.id, mark)
}

/** Waits for a turn on `threadId` that this client did not start (e.g. a `codex queue` push). */
export async function waitForPushedTurn(
  rpc: CodexRpc,
  threadId: string,
  after: number,
  timeoutMs: number,
): Promise<TurnSummary> {
  const started = await rpc.waitFor(
    `a pushed turn on ${threadId}`,
    (n) => n.method === 'turn/started' && n.params.threadId === threadId,
    timeoutMs,
    after,
  )
  turnBudget.take(`pushed turn on ${threadId}`)
  return waitCompleted(rpc, threadId, String(record(started.params.turn).id), after)
}

export const toolCall = (turn: TurnSummary, tool: string): ToolCall | undefined =>
  turn.toolCalls.find((c) => c.server === 'peers' && c.tool === tool)

/** One line per turn for the report: what the model did. */
export function describeTurn(turn: TurnSummary): string {
  const tools = turn.toolCalls.map((c) => `${c.tool}(${c.status})`).join(', ') || 'no tools'
  const hooks = turn.hooks.map((h) => `${h.event}:${h.status}`).join(', ') || 'no hooks'
  return `turn ${turn.turnId} [${turn.status}] tools: ${tools}; hooks: ${hooks}; says: ${turn.messages.at(-1)?.slice(0, 160) ?? ''}`
}
