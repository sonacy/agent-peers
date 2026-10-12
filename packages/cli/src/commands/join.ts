/**
 * `agent-peers join <invite_url> [--here | -a <agent…>] [--handle h] [--name member] [--summary s]
 *  [--remember workspace|session|none] [--dry-run] [-y]` (ONBOARDING §3): one-step onboarding.
 */
import { AutojoinScopeSchema } from '@agent-peers/core'
import { Command, InvalidArgumentError } from 'commander'
import { globalsOf } from '../globals'
import type { CliIo } from '../io'
import { runJoin } from '../join/run'
import type { JoinOptions, PeersDeps } from '../join/types'
import { collectAgents } from './installer-deps'

function parseScope(value: string) {
  const parsed = AutojoinScopeSchema.safeParse(value)
  if (!parsed.success) throw new InvalidArgumentError('expected workspace, session or none')
  return parsed.data
}

export function joinCommand(io: CliIo, setExit: (code: number) => void, deps: PeersDeps = {}): Command {
  return new Command('join')
    .description('join a room from an invite link: install into this agent, join, say hello')
    .argument('<invite_url>', 'the invite link, https://<hub>/j/<code>')
    .option('--here', 'install into and join as the agent running this command')
    .option('-a, --agent <agent...>', 'claude-code, claude-desktop, codex, codex-desktop', collectAgents)
    .option('--handle <handle>', 'the handle to claim in the room (never suffixed)')
    .option('--name <member>', 'your member name on this hub (default: the handle)')
    .option('--summary <text>', 'a one-line summary on your card')
    .option('--remember <scope>', 'auto-join scope: workspace, session or none', parseScope)
    .option('--session-key <key>', 'the agent session to join as (when running from a terminal)')
    .option('--insecure', 'allow plain http:// and ws:// to a public host')
    .option('--dry-run', 'show what would happen and stop before any change')
    .option('-y, --yes', 'no prompts')
    .action(async (url: string, options: JoinOptions, self: Command) => {
      const json = globalsOf(self).json === true ? { json: true } : {}
      setExit(await runJoin(url, { ...options, ...json }, io, deps))
    })
}
