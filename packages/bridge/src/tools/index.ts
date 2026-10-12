/** The bridge's MCP tools (adapters/tools.ts PEERS_TOOLS is the canonical list). */
import type { BridgeTool } from './define'
import { hookTool } from './hook'
import { inboxTools } from './inbox'
import { messagingTools } from './messaging'
import { roomTools } from './rooms'
import { sessionTools } from './session'

export const BRIDGE_TOOLS: readonly BridgeTool[] = [
  ...roomTools,
  ...sessionTools,
  ...messagingTools,
  ...inboxTools,
  hookTool,
]

export const HOOK_TOOL = hookTool.name

/** ARCHITECTURE §8 item 3: denied during a peer turn (worm and exfiltration chains). */
export const PEER_TURN_DENIED: ReadonlySet<string> = new Set([
  'peers_send',
  'peers_ask',
  'peers_join',
  'peers_leave',
  'peers_create',
  'peers_invite',
  'peers_knock',
])

const BY_NAME: ReadonlyMap<string, BridgeTool> = new Map(BRIDGE_TOOLS.map((tool) => [tool.name, tool]))

export const findTool = (name: string): BridgeTool | undefined => BY_NAME.get(name)
