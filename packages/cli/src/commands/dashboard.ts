/**
 * `agent-peers dashboard`: a one-time login link (`dashboard.login`), opened in the browser and
 * printed. The link comes from the hub, so it is opened only when it is an http(s) URL on that very
 * hub's origin; anything else is printed (sanitized) and never handed to the opener.
 */
import { hubOrigin } from '@agent-peers/core'
import { sanitizeLine } from '@agent-peers/protocol'
import type { Command } from 'commander'
import { EXIT } from '../errors'
import type { CliIo } from '../io'
import type { ShellOptions } from '../join/shell'
import { runShell, shellCommand, shellOptions } from '../join/shell-command'
import type { PeersDeps } from '../join/types'

const OPENERS: Readonly<Partial<Record<NodeJS.Platform, readonly string[]>>> = {
  darwin: ['open'],
  linux: ['xdg-open'],
  // Not `cmd /c start`: cmd.exe would parse `&`, `|` and `^` in the URL.
  win32: ['rundll32', 'url.dll,FileProtocolHandler'],
}

/** `url` normalized when it is an http(s) URL on the hub's own origin; undefined otherwise. */
export function dashboardUrlFor(url: string, origin: string): string | undefined {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return undefined
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return undefined
  if (parsed.username !== '' || parsed.password !== '') return undefined
  return parsed.origin === hubOrigin(origin) ? parsed.href : undefined
}

/** Opens `url` with the platform's opener; false when there is none or it failed. */
export async function openInBrowser(
  url: string,
  platform: NodeJS.Platform = process.platform,
): Promise<boolean> {
  const opener = OPENERS[platform]
  if (!opener) return false
  try {
    const proc = Bun.spawn([...opener, url], { stdin: 'ignore', stdout: 'ignore', stderr: 'ignore' })
    return (await proc.exited) === 0
  } catch {
    return false
  }
}

export async function runDashboard(options: ShellOptions, io: CliIo, deps: PeersDeps = {}): Promise<number> {
  return runShell(io, deps, options, async (ctx, print, emit) => {
    const { url } = await ctx.hub.session.dashboardLogin()
    const safe = dashboardUrlFor(url, ctx.origin)
    if (safe === undefined) {
      const shown = sanitizeLine(url, 512)
      print(`the hub sent a dashboard link that is not on ${ctx.origin}; not opening it: ${shown}`)
      emit({ url: shown, opened: false, unexpected: true })
      return EXIT.failure
    }
    const opened = await (deps.openUrl ?? openInBrowser)(safe)
    print(`${opened ? 'opened' : 'open this link'} (single use, valid for 5 minutes): ${safe}`)
    emit({ url: safe, opened })
    return undefined
  })
}

export function dashboardCommand(io: CliIo, setExit: (code: number) => void, deps: PeersDeps = {}): Command {
  return shellCommand('dashboard', 'open the web dashboard, already signed in').action(
    async (options: ShellOptions, self: Command) => {
      setExit(await runDashboard(shellOptions(options, self), io, deps))
    },
  )
}
