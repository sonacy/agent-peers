/**
 * `agent-peers join <invite_url>` (ONBOARDING §3): preview, detect, install, membership, join and
 * hello, remember, result. Exit codes: 0 ok, 1 failure, 2 usage, 3 blocked by the agent's sandbox.
 */
import { assertTransportAllowed, toWebSocketUrl } from '@agent-peers/core'
import { printer } from '../commands/installer-deps'
import { EXIT } from '../errors'
import type { CliIo } from '../io'
import { type JoinContext, joinContext, type LocalSetup, localSetup } from './context'
import { describeFailure, isSandboxFailure, type StopReport } from './errors'
import { assertHttpAllowed, fetchPreview } from './hub-http'
import { previewLines } from './preview'
import { sandboxCommand, sandboxReport } from './sandbox'
import {
  bootstrapKey,
  detectStep,
  installAgents,
  membershipAndJoin,
  type Print,
  rememberAndFinish,
} from './steps'
import type { JoinOptions, PeersDeps } from './types'

const JSON_CODES: Readonly<Record<number, string>> = {
  [EXIT.usage]: 'invalid_params',
  [EXIT.sandbox]: 'sandbox_blocked',
  [EXIT.unreachable]: 'unreachable',
  [EXIT.auth]: 'unauthorized',
}

const DONE: StopReport = { code: EXIT.ok, lines: [] }

/**
 * The final report. With `--json` the progress lines went to stderr and stdout carries one JSON
 * document: `{ ok: true, lines }`, or `{ error: { code, message, lines } }` as `renderError` shapes it.
 */
function report(io: CliIo, stop: StopReport, json = false): number {
  if (json) {
    const lines = stop.lines.map((line) => line.replace(/^agent-peers: /, ''))
    const body =
      stop.code === EXIT.ok
        ? { ok: true, lines }
        : { error: { code: JSON_CODES[stop.code] ?? 'internal', message: lines.join(' '), lines } }
    io.stdout(`${JSON.stringify(body)}\n`)
    return stop.code
  }
  if (stop.lines.length === 0) return stop.code
  const text = `${stop.lines.join('\n')}\n`
  if (stop.code === EXIT.ok) io.stdout(text)
  else io.stderr(text)
  return stop.code
}

/** Progress lines: stdout, or stderr under `--json` (stdout is the JSON document). */
const progress = (io: CliIo, json: boolean | undefined): Print =>
  json ? (...lines) => (lines.length > 0 ? io.stderr(`${lines.join('\n')}\n`) : undefined) : printer(io)

/**
 * A sandbox-shaped failure inside an agent stops with exit 3 and the escalation command. It needs
 * only the local setup: a sandboxed network usually fails at the preview, before there is a context.
 */
function failure(error: unknown, setup: LocalSetup, options: JoinOptions, key: string): StopReport {
  if (setup.agent.current !== undefined && isSandboxFailure(error, setup.agent.sandboxed)) {
    const reason = error instanceof Error ? error.message : String(error)
    return sandboxReport(reason, sandboxCommand(setup, options, setup.agent.agentKey ?? key))
  }
  return describeFailure(error)
}

async function preview(setup: LocalSetup, options: JoinOptions, deps: PeersDeps, print: Print) {
  assertHttpAllowed(setup.invite.origin, options.insecure === true)
  assertTransportAllowed(toWebSocketUrl(setup.invite.origin), options.insecure === true)
  const fetched = await fetchPreview(deps.fetch ?? fetch, setup.invite.origin, setup.invite.code)
  const ctx = await joinContext(setup, fetched, options)
  const [headline = '', ...rest] = previewLines({
    origin: ctx.invite.origin,
    preview: ctx.preview,
    credential: ctx.credential,
    memberName: ctx.memberName,
    handle: ctx.handle,
    kind: ctx.agent.kind,
    card: ctx.card,
    workspace: ctx.workspaceFields,
  })
  print(`[1/7] preview: ${headline}`, ...rest.map((line) => `    ${line}`))
  return ctx
}

async function execute(ctx: JoinContext, options: JoinOptions, deps: PeersDeps, print: Print, key: string) {
  const blocked = await detectStep(ctx, options, key, print)
  if (blocked) return blocked
  const install = await installAgents(ctx, deps, print)
  if (!install.ok)
    return {
      code: EXIT.failure,
      lines: ['agent-peers: the install failed (see above); nothing was redeemed'],
    }
  const joined = await membershipAndJoin(ctx, options, deps, key, print)
  if ('code' in joined) return joined
  await rememberAndFinish(ctx, options, deps, joined, install, print)
  return undefined
}

export async function runJoin(
  url: string,
  options: JoinOptions,
  io: CliIo,
  deps: PeersDeps = {},
): Promise<number> {
  const print = progress(io, options.json)
  const setup = await localSetup(url, options, io, deps).catch((error: unknown) => ({
    kind: 'stop' as const,
    report: describeFailure(error),
  }))
  if (setup.kind === 'stop') return report(io, setup.report, options.json)
  let key = ''
  try {
    const ctx = await preview(setup.value, options, deps, print)
    if (options.dryRun) {
      print('dry run: stopping after the preview; nothing was installed, redeemed or written')
      return report(io, DONE, options.json)
    }
    key = await bootstrapKey(ctx, deps)
    const stop = await execute(ctx, options, deps, print, key)
    return report(io, stop ?? DONE, options.json)
  } catch (error) {
    return report(io, failure(error, setup.value, options, key), options.json)
  }
}
