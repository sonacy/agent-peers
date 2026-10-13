/**
 * Package code reached from `test/live` (not a workspace, so bare `@agent-peers/*` specifiers do not
 * resolve here). The in-process hub is the e2e one: in-memory SQLite, loopback, port 0.
 */
export {
  HubClient,
  type NotificationMap,
  SessionHandle,
} from '../../../../packages/core/src/index'
export { type CardView, type E2eHub, type E2eRoom, startE2eHub } from '../../../e2e/support/hub'
export { eventually, within } from '../../../e2e/support/wait'
