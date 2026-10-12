/**
 * Linux: a user unit at `${XDG_CONFIG_HOME:-~/.config}/systemd/user/agent-peers-hub.service`,
 * enabled and (re)started with `systemctl --user`.
 */
import { isAbsolute, join } from 'node:path'
import { PeersError } from '@agent-peers/protocol'
import type { RunResult } from '../agents/types'
import type { ServiceContext, ServiceManager, ServiceSpec, ServiceStatus } from './types'

export const SYSTEMD_UNIT = 'agent-peers-hub.service'

/**
 * One ExecStart / Environment word: double-quoted, with `\` and `"` escaped, `%` doubled
 * (specifiers) and `$` doubled (variable expansion), so paths with spaces survive.
 */
export function quoteSystemd(word: string): string {
  if (/[\n\r]/.test(word)) throw new PeersError('invalid_params', 'service arguments cannot contain newlines')
  const escaped = word.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/%/g, '%%').replace(/\$/g, '$$$$')
  return `"${escaped}"`
}

export function renderUnit(spec: ServiceSpec): string {
  const exec = [spec.binary, ...spec.args].map(quoteSystemd).join(' ')
  const env = Object.entries(spec.env).map(([key, value]) => `Environment=${quoteSystemd(`${key}=${value}`)}`)
  return [
    '[Unit]',
    'Description=agent-peers hub',
    'After=network-online.target',
    'Wants=network-online.target',
    '',
    '[Service]',
    'Type=simple',
    `ExecStart=${exec}`,
    ...env,
    `WorkingDirectory=${quoteSystemd(spec.workingDir)}`,
    'Restart=on-failure',
    'RestartSec=5',
    '',
    '[Install]',
    'WantedBy=default.target',
    '',
  ].join('\n')
}

function configHome(ctx: ServiceContext): string {
  const xdg = ctx.env.XDG_CONFIG_HOME?.trim()
  return xdg && isAbsolute(xdg) ? xdg : join(ctx.userHome, '.config')
}

const systemctl = (ctx: ServiceContext, ...args: string[]) => ctx.run(['systemctl', '--user', ...args])

function failed(what: string, result: RunResult): PeersError {
  const why = (result.stderr || result.stdout).trim() || `exit code ${result.code}`
  return new PeersError('internal', `${what} failed: ${why}`)
}

async function must(ctx: ServiceContext, ...args: string[]): Promise<void> {
  const result = await systemctl(ctx, ...args)
  if (result.code !== 0) throw failed(`systemctl --user ${args.join(' ')}`, result)
}

export const systemd: ServiceManager = {
  name: 'systemd',
  unitPath: (ctx) => join(configHome(ctx), 'systemd', 'user', SYSTEMD_UNIT),
  render: renderUnit,
  async activate(ctx) {
    await must(ctx, 'daemon-reload')
    await must(ctx, 'enable', SYSTEMD_UNIT)
    await must(ctx, 'restart', SYSTEMD_UNIT)
    return [`enabled and started ${SYSTEMD_UNIT}`]
  },
  async deactivate(ctx) {
    const result = await systemctl(ctx, 'disable', '--now', SYSTEMD_UNIT)
    return [result.code === 0 ? `stopped and disabled ${SYSTEMD_UNIT}` : `${SYSTEMD_UNIT} was not enabled`]
  },
  async afterRemove(ctx) {
    await must(ctx, 'daemon-reload')
  },
  async status(ctx, installed): Promise<ServiceStatus> {
    const active = await systemctl(ctx, 'is-active', SYSTEMD_UNIT)
    const state = active.stdout.trim() || 'unknown'
    const shown = await systemctl(ctx, 'show', '--property=MainPID', '--value', SYSTEMD_UNIT)
    const pid = Number(shown.stdout.trim())
    return {
      manager: 'systemd',
      unitPath: systemd.unitPath(ctx),
      installed,
      loaded: installed && state !== 'unknown',
      running: state === 'active',
      ...(Number.isInteger(pid) && pid > 0 ? { pid } : {}),
      detail: state,
    }
  },
  hints: () => [
    `logs: journalctl --user -u ${SYSTEMD_UNIT} -f`,
    'to keep the hub running while you are logged out: loginctl enable-linger "$USER"',
  ],
}
