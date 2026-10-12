/** Formatting and validation for the operator view (DASHBOARD §10): durations, URLs, error copy. */
import { isLoopbackHost, normalizePublicUrl } from '@agent-peers/protocol'
import { friendlyError, isApiError, isUnauthorized } from '../../api/errors'
import type { Registration } from './admin-schemas'

const SECOND = 1000
const MINUTE = 60 * SECOND
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

/** `45 秒`, `12 分钟`, `3 小时 5 分钟`, `30 天`, `2 天 4 小时`: the two largest units, no zeros. */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < MINUTE) return `${Math.max(0, Math.floor(ms / SECOND) || 0)} 秒`
  const units: readonly (readonly [number, string])[] = [
    [DAY, '天'],
    [HOUR, '小时'],
    [MINUTE, '分钟'],
  ]
  const first = units.findIndex(([size]) => ms >= size)
  return units
    .slice(first, first + 2)
    .reduce<{ readonly rest: number; readonly parts: readonly string[] }>(
      (acc, [size, label]) => {
        const n = Math.floor(acc.rest / size)
        return { rest: acc.rest - n * size, parts: n > 0 ? [...acc.parts, `${n} ${label}`] : acc.parts }
      },
      { rest: ms, parts: [] },
    )
    .parts.join(' ')
}

export const REGISTRATION_LABEL: Readonly<Record<Registration, string>> = {
  'invite-only': '只能用邀请',
  open: '开放注册',
}

/** True when the URL points at this machine only (teammates can't reach it). */
export function isLoopbackUrl(url: string | null | undefined): boolean {
  if (url === null || url === undefined || url === '') return false
  try {
    return isLoopbackHost(new URL(url).hostname)
  } catch {
    return false
  }
}

/** Why a public URL is unusable, or undefined when the hub would accept it. */
export function publicUrlProblem(value: string): string | undefined {
  const trimmed = value.trim()
  if (trimmed === '') return '填一个地址，比如 https://peers.example.com'
  if (!/^https?:\/\//i.test(trimmed)) return '要以 http:// 或 https:// 开头'
  try {
    normalizePublicUrl(trimmed)
    return undefined
  } catch {
    return '这个地址用不了：不能带账号、查询参数或 #，换一个试试'
  }
}

/** Operator-facing copy: a 401 here means the admin token, not the member sign-in. */
export function adminErrorText(error: unknown): string {
  if (isUnauthorized(error)) {
    return '令牌不对，或者登录过期了。用 hub 启动时打印的管理令牌（data 目录里的 admin-token 文件）再登录。'
  }
  if (isApiError(error) && error.code === 'target_not_found') return '没找到，可能已经被删掉了。刷新看看。'
  if (isApiError(error) && error.code === 'forbidden') return '只有在 hub 这台机器上才能打开运维页。'
  return friendlyError(error)
}
