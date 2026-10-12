/**
 * macOS: a LaunchAgent at `~/Library/LaunchAgents/dev.agent-peers.hub.plist`, loaded into the
 * user's GUI domain with `launchctl bootstrap gui/<uid>` (RunAtLoad, restarted when it crashes).
 */
import { join } from 'node:path'
import { PeersError } from '@agent-peers/protocol'
import type { RunResult } from '../agents/types'
import type { ServiceContext, ServiceManager, ServiceSpec, ServiceStatus } from './types'

export const LAUNCHD_LABEL = 'dev.agent-peers.hub'

export function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

const str = (value: string) => `<string>${escapeXml(value)}</string>`

export function renderPlist(spec: ServiceSpec): string {
  const args = [spec.binary, ...spec.args].map((arg) => `    ${str(arg)}`).join('\n')
  const env = Object.entries(spec.env)
    .map(([key, value]) => `    <key>${escapeXml(key)}</key>\n    ${str(value)}`)
    .join('\n')
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  ${str(LAUNCHD_LABEL)}
  <key>ProgramArguments</key>
  <array>
${args}
  </array>
  <key>EnvironmentVariables</key>
  <dict>
${env}
  </dict>
  <key>WorkingDirectory</key>
  ${str(spec.workingDir)}
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>ThrottleInterval</key>
  <integer>10</integer>
  <key>ProcessType</key>
  <string>Background</string>
  <key>StandardOutPath</key>
  ${str(spec.logPath)}
  <key>StandardErrorPath</key>
  ${str(spec.logPath)}
</dict>
</plist>
`
}

const domain = (ctx: ServiceContext) => `gui/${ctx.uid}`
const target = (ctx: ServiceContext) => `${domain(ctx)}/${LAUNCHD_LABEL}`

function failed(what: string, result: RunResult): PeersError {
  const why = (result.stderr || result.stdout).trim() || `exit code ${result.code}`
  return new PeersError('internal', `${what} failed: ${why}`)
}

/** `launchctl print` output: `state = running`, `pid = 123`. */
export function parseLaunchdPrint(output: string): { readonly running: boolean; readonly pid?: number } {
  const state = /^\s*state = (\S+)/m.exec(output)?.[1]
  const pid = /^\s*pid = (\d+)/m.exec(output)?.[1]
  return { running: state === 'running', ...(pid === undefined ? {} : { pid: Number(pid) }) }
}

export const launchd: ServiceManager = {
  name: 'launchd',
  unitPath: (ctx) => join(ctx.userHome, 'Library', 'LaunchAgents', `${LAUNCHD_LABEL}.plist`),
  render: renderPlist,
  async activate(ctx) {
    // Reinstalling replaces a loaded job: bootout first (an error just means it was not loaded).
    await ctx.run(['launchctl', 'bootout', target(ctx)])
    const result = await ctx.run(['launchctl', 'bootstrap', domain(ctx), launchd.unitPath(ctx)])
    if (result.code !== 0) throw failed('launchctl bootstrap', result)
    return [`loaded ${LAUNCHD_LABEL} into ${domain(ctx)} (starts at login, restarts if it crashes)`]
  },
  async deactivate(ctx) {
    const result = await ctx.run(['launchctl', 'bootout', target(ctx)])
    return [result.code === 0 ? `stopped and unloaded ${LAUNCHD_LABEL}` : `${LAUNCHD_LABEL} was not loaded`]
  },
  async status(ctx, installed): Promise<ServiceStatus> {
    const result = await ctx.run(['launchctl', 'print', target(ctx)])
    const base = { manager: 'launchd' as const, unitPath: launchd.unitPath(ctx), installed }
    if (result.code !== 0) return { ...base, loaded: false, running: false }
    return { ...base, loaded: true, ...parseLaunchdPrint(result.stdout) }
  },
  hints: (_ctx, spec) => [`logs: ${spec.logPath}`],
}
