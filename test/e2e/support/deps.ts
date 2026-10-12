/**
 * The workspace packages and the MCP SDK, reached from `test/e2e` (which is not a workspace, so bare
 * `@agent-peers/*` specifiers do not resolve here). Every e2e import of package code goes through
 * this file, so moving the tests into a workspace later is a one-file change.
 */

export { Client } from '../../../packages/bridge/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js'
export { StdioClientTransport } from '../../../packages/bridge/node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js'
export {
  type AutojoinEntry,
  HubClient,
  LocalHome,
  type NotificationMap,
  SessionHandle,
} from '../../../packages/core/src/index'
export { createHub, type Hub, silentLogger } from '../../../packages/hub/src/index'
