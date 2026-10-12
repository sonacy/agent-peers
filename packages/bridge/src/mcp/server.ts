/**
 * The MCP server: `tools/list` and `tools/call` over the bridge's tools. Until the surface is verified
 * (and forever, when it is not), the tool list is empty and calls are refused.
 */

import { PeersError } from '@agent-peers/protocol'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import {
  CallToolRequestSchema,
  type CallToolResult,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'
import type { Runtime } from '../runtime'
import type { BridgeSession } from '../session/bridge-session'
import { ADAPTER_VERSION } from '../session/card'
import {
  type BridgeTool,
  errorResult,
  type ToolCall,
  type ToolContext,
  type ToolResult,
} from '../tools/define'
import { BRIDGE_TOOLS, findTool, HOOK_TOOL, PEER_TURN_DENIED } from '../tools/index'

export const SERVER_NAME = 'agent-peers'

export interface McpServerHooks {
  /** The verified runtime, or undefined while inactive. */
  runtime(): Runtime | undefined
  /** Why the bridge is inactive (shown on refused calls). */
  inactiveReason(): string
}

function record(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function turnMetadata(meta: unknown): Readonly<Record<string, unknown>> | undefined {
  const raw = record(meta)?.['x-codex-turn-metadata']
  if (typeof raw !== 'string') return record(raw)
  try {
    return record(JSON.parse(raw))
  } catch {
    return undefined
  }
}

function metaField(meta: unknown, field: 'thread_id' | 'turn_id'): string | undefined {
  const value = turnMetadata(meta)?.[field]
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/** Codex stamps every tools/call with `_meta["x-codex-turn-metadata"].thread_id` (ARCHITECTURE §6.1). */
export const threadIdOf = (meta: unknown): string | undefined => metaField(meta, 'thread_id')

/** …and the id of the turn the call runs in. */
export const turnIdOf = (meta: unknown): string | undefined => metaField(meta, 'turn_id')

function callIdentity(args: unknown, meta: unknown, signal: AbortSignal): ToolCall {
  const key = record(args)?.session_key
  const threadId = threadIdOf(meta)
  const turnId = turnIdOf(meta)
  return {
    signal,
    ...(typeof key === 'string' && key.length > 0 ? { sessionKey: key } : {}),
    ...(threadId ? { threadId } : {}),
    ...(turnId ? { turnId } : {}),
  }
}

/** `peers_hook` exists only where hooks call it as an MCP tool (Codex); elsewhere it is not listed. */
export const listedTools = (rt: Runtime): readonly BridgeTool[] =>
  rt.descriptor.hooks === 'mcp-tool' ? BRIDGE_TOOLS : BRIDGE_TOOLS.filter((tool) => tool.name !== HOOK_TOOL)

function assertAllowed(rt: Runtime, session: BridgeSession, tool: string): void {
  if (!rt.descriptor.gated || session.queue.peerTurn === null || !PEER_TURN_DENIED.has(tool)) return
  throw new PeersError(
    'forbidden',
    `${tool} is disabled while this session answers a peer ask (no relaying remote requests)`,
  )
}

/** Runs one tool for the calling session; every failure becomes a tool error with its protocol code. */
export async function runTool(
  rt: Runtime,
  tool: BridgeTool,
  args: unknown,
  call: ToolCall,
): Promise<ToolResult> {
  const ctx: ToolContext = {
    rt,
    call,
    tool: tool.name,
    session: async (hub) => {
      const session = await rt.registry.resolve({
        ...(call.sessionKey ? { sessionKey: call.sessionKey } : {}),
        ...(call.threadId ? { threadId: call.threadId } : {}),
        ...(hub ? { hub } : {}),
      })
      assertAllowed(rt, session, tool.name)
      return session
    },
  }
  try {
    if (tool.name === HOOK_TOOL && rt.descriptor.hooks !== 'mcp-tool')
      throw new PeersError('forbidden', 'peers_hook is only used by the Codex plugin hooks')
    return await tool.invoke(ctx, args)
  } catch (error) {
    return errorResult(error)
  }
}

const toCallResult = (result: ToolResult): CallToolResult => ({
  content: [{ type: 'text', text: result.text }],
  ...(result.structured ? { structuredContent: { ...result.structured } } : {}),
  ...(result.isError ? { isError: true } : {}),
})

export function createMcpServer(instructions: string, hooks: McpServerHooks): Server {
  const server = new Server(
    { name: SERVER_NAME, version: ADAPTER_VERSION },
    { capabilities: { tools: { listChanged: false } }, instructions },
  )
  server.setRequestHandler(ListToolsRequestSchema, () => {
    const rt = hooks.runtime()
    return {
      tools: rt
        ? listedTools(rt).map((tool) => ({
            name: tool.name,
            description: tool.description,
            inputSchema: { type: 'object' as const, ...tool.inputSchema },
            ...(tool.annotations ? { annotations: { ...tool.annotations } } : {}),
          }))
        : [],
    }
  })
  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const rt = hooks.runtime()
    if (!rt) return toCallResult(errorResult(new PeersError('forbidden', hooks.inactiveReason())))
    const tool = findTool(request.params.name)
    if (!tool)
      return toCallResult(
        errorResult(new PeersError('method_not_found', `unknown tool ${request.params.name}`)),
      )
    const call = callIdentity(request.params.arguments, request.params._meta, extra.signal)
    return toCallResult(await runTool(rt, tool, request.params.arguments ?? {}, call))
  })
  return server
}
