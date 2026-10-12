/**
 * Member-API failures (`{ error: { code, message, retry_after_ms? } }`, PROTOCOL §9) as one error
 * class, and the friendly copy each code shows in the UI: why it failed and what to do next (§9).
 */
import { type ErrorCode, isErrorCode } from '@agent-peers/protocol'

export class ApiError extends Error {
  readonly code: ErrorCode
  /** HTTP status; 0 when the request never got a response. */
  readonly status: number
  readonly retryAfterMs: number | undefined

  constructor(code: ErrorCode, message: string, status: number, retryAfterMs?: number) {
    super(message)
    this.name = 'ApiError'
    this.code = code
    this.status = status
    this.retryAfterMs = retryAfterMs
  }
}

export function isApiError(error: unknown): error is ApiError {
  return error instanceof ApiError
}

/** The code to use when the body carries none: derived from the HTTP status. */
export function codeForStatus(status: number): ErrorCode {
  if (status === 401) return 'unauthorized'
  if (status === 403) return 'forbidden'
  if (status === 404) return 'room_not_found'
  if (status === 413) return 'payload_too_large'
  if (status === 429) return 'rate_limited'
  if (status === 400 || status === 422) return 'invalid_params'
  return 'internal'
}

export function toErrorCode(value: string, status: number): ErrorCode {
  return isErrorCode(value) ? value : codeForStatus(status)
}

const FRIENDLY: Readonly<Partial<Record<ErrorCode, string>>> = {
  unauthorized: '登录过期了。打开你的 agent，输入 /peers:dashboard 重新进来。',
  forbidden: '这件事只有房主能做。想改的话找房主帮忙。',
  rename_conflict: '这个名字刚被别人用了，换一个试试。',
  handle_taken: '这个名字在房间里已经有人用了，换一个试试。',
  invalid_name: '名字只能用小写字母、数字、- 和 _，以字母或数字开头，最多 32 个字。',
  invite_closed: '邀请已经关了。找房主要一个新邀请，或者敲门。',
  invite_invalid: '这个邀请不能用了，找房主要一个新的。',
  already_member: '你已经在这个房间里了，刷新看看。',
  knock_pending: '已经敲过门了，等房主开门就好。',
  room_not_found: '找不到这个房间，可能已经解散了。回到房间列表看看。',
  unknown_session: '找不到这个 agent，它可能已经退出了。刷新看看。',
  target_not_found: '找不到对方，可能已经离开房间了。',
  invalid_params: '填的内容不太对，检查一下再试。',
  payload_too_large: '内容太长了，删短一点再试。',
  disconnected: '连不上 Core。检查网络或 Core 是否在运行，然后再试。',
  timeout: 'Core 太久没回应，稍后再试。',
  invalid_result: 'Core 返回的数据看不懂，可能版本不一致。刷新页面再试。',
  method_not_found: '这个 Core 版本还不支持这个操作，升级 Core 后再试。',
}

const FALLBACK = 'Core 出了点问题，稍后再试。'

/** One sentence for toasts and inline errors. Unknown errors get a generic next step. */
export function friendlyError(error: unknown): string {
  if (!isApiError(error)) return FALLBACK
  if (error.code === 'rate_limited') {
    const seconds = Math.max(1, Math.ceil((error.retryAfterMs ?? 5000) / 1000))
    return `操作太快了，${seconds} 秒后再试。`
  }
  return FRIENDLY[error.code] ?? FALLBACK
}

export function isUnauthorized(error: unknown): boolean {
  return isApiError(error) && error.code === 'unauthorized'
}

/** Signing out when the hub already says signed out (401) is the outcome we wanted. */
export async function signOutWith(logout: () => Promise<void>): Promise<void> {
  try {
    await logout()
  } catch (error) {
    if (!isUnauthorized(error)) throw error
  }
}

export function isNotFound(error: unknown): boolean {
  return isApiError(error) && (error.code === 'room_not_found' || error.status === 404)
}

/** No access (e.g. removed from the room): retrying won't change the answer. */
export function isForbidden(error: unknown): boolean {
  return isApiError(error) && error.code === 'forbidden'
}
