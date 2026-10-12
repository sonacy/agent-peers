/** `agent-peers status <summary…> [--dnd | --open]`: the card's one-line summary and do-not-disturb. */
import { sanitizeLine } from '@agent-peers/protocol'
import type { Command } from 'commander'
import type { CliIo } from '../io'
import type { ShellOptions } from '../join/shell'
import { runShell, shellCommand, shellOptions, usageFailure } from '../join/shell-command'
import type { PeersDeps } from '../join/types'

export interface StatusOptions extends ShellOptions {
  readonly dnd?: boolean
  readonly open?: boolean
}

export async function runStatus(
  words: readonly string[],
  options: StatusOptions,
  io: CliIo,
  deps: PeersDeps = {},
): Promise<number> {
  const summary = sanitizeLine(words.join(' '), 80)
  if (options.dnd && options.open) return usageFailure(io, options, 'pass either --dnd or --open')
  const accepting = options.dnd ? false : options.open ? true : undefined
  if (!summary && accepting === undefined)
    return usageFailure(io, options, 'usage: agent-peers status <summary> [--dnd | --open]')
  return runShell(io, deps, options, async (ctx, print, emit) => {
    await ctx.hub.session.update({
      ...(summary ? { summary } : {}),
      ...(accepting === undefined ? {} : { accepting }),
    })
    print(
      ...(summary ? [`summary: ${summary}`] : []),
      ...(accepting === undefined ? [] : [accepting ? 'accepting asks' : 'do not disturb: asks are held']),
    )
    emit({ ...(summary ? { summary } : {}), ...(accepting === undefined ? {} : { accepting }) })
    return undefined
  })
}

export function statusCommand(io: CliIo, setExit: (code: number) => void, deps: PeersDeps = {}): Command {
  return shellCommand('status', 'set your one-line summary and do-not-disturb')
    .argument('[summary...]', 'what this session is working on')
    .option('--dnd', 'hold asks (do not disturb)')
    .option('--open', 'accept asks again')
    .action(async (words: string[], options: StatusOptions, self: Command) => {
      const flags = { dnd: options.dnd === true, open: options.open === true }
      setExit(await runStatus(words, { ...shellOptions(options, self), ...flags }, io, deps))
    })
}
