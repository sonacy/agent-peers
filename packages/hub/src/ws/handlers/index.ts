/** The full request handler table. `hello` and `bye` are handled by the dispatcher itself. */
import { messageHandlers } from './messages'
import { roomHandlers } from './rooms'
import { sessionHandlers } from './session'
import type { HandlerTable } from './types'

export const HANDLERS: HandlerTable = Object.freeze({
  ...sessionHandlers,
  ...roomHandlers,
  ...messageHandlers,
})
export type { Handler, HandlerContext, HandlerTable, Reply } from './types'
