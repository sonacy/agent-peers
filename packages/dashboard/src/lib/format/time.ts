/** Time formatting (DASHBOARD §8). Timestamps are epoch milliseconds, as the hub sends them. */

const SECOND = 1000
const MINUTE = 60 * SECOND
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

const pad2 = (n: number): string => String(n).padStart(2, '0')

function sameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()
}

export function formatClock(date: Date): string {
  return `${pad2(date.getHours())}:${pad2(date.getMinutes())}`
}

/**
 * §8 relative time: `刚刚` under 60s, `{n} 分钟前` under 60m, `今天 18:09` today, `10 月 3 日` this
 * year, `2025 年 12 月 3 日` before that. Future timestamps (clock skew) read as `刚刚`.
 */
export function formatRelativeTime(ts: number, now: number = Date.now()): string {
  const age = now - ts
  if (age < MINUTE) return '刚刚'
  if (age < HOUR) return `${Math.floor(age / MINUTE)} 分钟前`
  const date = new Date(ts)
  const today = new Date(now)
  if (sameDay(date, today)) return `今天 ${formatClock(date)}`
  const monthDay = `${date.getMonth() + 1} 月 ${date.getDate()} 日`
  if (date.getFullYear() === today.getFullYear()) return monthDay
  return `${date.getFullYear()} 年 ${monthDay}`
}

/** Short "ago" for status lines (§3): `25 秒前`, `12 分钟前`, `2 小时前`, `3 天前`; `刚刚` under 5s. */
export function formatAgo(ts: number, now: number = Date.now()): string {
  const age = now - ts
  if (age < 5 * SECOND) return '刚刚'
  if (age < MINUTE) return `${Math.floor(age / SECOND)} 秒前`
  if (age < HOUR) return `${Math.floor(age / MINUTE)} 分钟前`
  if (age < DAY) return `${Math.floor(age / HOUR)} 小时前`
  return `${Math.floor(age / DAY)} 天前`
}

/** The full timestamp shown in tooltips: `2026 年 10 月 3 日 18:09:05`. */
export function formatFullTimestamp(ts: number): string {
  const d = new Date(ts)
  const time = `${formatClock(d)}:${pad2(d.getSeconds())}`
  return `${d.getFullYear()} 年 ${d.getMonth() + 1} 月 ${d.getDate()} 日 ${time}`
}

/** `10 月 7 日` (room hero `{date} 创建`), with the year when it differs from now. */
export function formatDate(ts: number, now: number = Date.now()): string {
  const d = new Date(ts)
  const monthDay = `${d.getMonth() + 1} 月 ${d.getDate()} 日`
  return d.getFullYear() === new Date(now).getFullYear() ? monthDay : `${d.getFullYear()} 年 ${monthDay}`
}
