/** Options and seams of `agent-peers join` and the shell fallback commands. */
import type { AutojoinScope, ProcessTree, WebSocketFactory } from '@agent-peers/core'
import type { InstallerDeps } from '../commands/installer-deps'

export interface JoinOptions {
  readonly agent?: readonly string[]
  readonly here?: boolean
  readonly handle?: string
  readonly name?: string
  readonly summary?: string
  readonly remember?: AutojoinScope
  readonly dryRun?: boolean
  readonly yes?: boolean
  /** The agent session to join as, for running the join from a terminal (ONBOARDING §3 step 2). */
  readonly sessionKey?: string
  /** Allow plain http:// / ws:// to a public host (PROTOCOL §1). */
  readonly insecure?: boolean
  /** The global `--json`: progress on stderr, one JSON document on stdout. */
  readonly json?: boolean
}

/** Seams shared by `join` and the shell commands (tests run them in-process against a temp HOME). */
export interface PeersDeps extends InstallerDeps {
  /** The working directory (default `process.cwd()`). */
  readonly cwd?: string
  /** The machine's host name (default `os.hostname()`). */
  readonly hostname?: string
  /** ULID source for bootstrap keys. */
  readonly newId?: () => string
  readonly webSocketFactory?: WebSocketFactory
  readonly requestTimeoutMs?: number
  /** Process tree for bridge discovery and the running Codex binary. */
  readonly processTree?: ProcessTree
  /** A process's executable path (Linux `/proc/<pid>/exe`), for the running Codex binary. */
  readonly exePath?: (pid: number) => Promise<string | undefined>
  /** Opens a URL in the browser (`dashboard`); false when it could not. */
  readonly openUrl?: (url: string) => Promise<boolean>
  /** How long the control-socket `autojoin` waits for each bridge. */
  readonly controlTimeoutMs?: number
}
