import { describe, expect, it } from 'bun:test'
import { formatCount, formatOverflow } from '../../src/lib/format/count'
import { failReasonText, UNKNOWN_REASON_TEXT } from '../../src/lib/format/reasons'
import { initialOf, truncateEnd, truncateMiddle } from '../../src/lib/format/text'
import {
  formatAgo,
  formatClock,
  formatDate,
  formatFullTimestamp,
  formatRelativeTime,
} from '../../src/lib/format/time'

const NOW = new Date(2026, 9, 12, 20, 0, 0).getTime()
const at = (y: number, m: number, d: number, h = 0, min = 0) => new Date(y, m - 1, d, h, min).getTime()

describe('formatRelativeTime (§8)', () => {
  it('says 刚刚 under a minute and for future timestamps', () => {
    expect(formatRelativeTime(NOW - 40_000, NOW)).toBe('刚刚')
    expect(formatRelativeTime(NOW, NOW)).toBe('刚刚')
    expect(formatRelativeTime(NOW + 5_000, NOW)).toBe('刚刚')
  })
  it('counts minutes under an hour', () => {
    expect(formatRelativeTime(NOW - 60_000, NOW)).toBe('1 分钟前')
    expect(formatRelativeTime(NOW - 12 * 60_000, NOW)).toBe('12 分钟前')
    expect(formatRelativeTime(NOW - 59 * 60_000 - 59_000, NOW)).toBe('59 分钟前')
  })
  it('shows the clock for earlier today', () => {
    expect(formatRelativeTime(at(2026, 10, 12, 18, 9), NOW)).toBe('今天 18:09')
    expect(formatRelativeTime(at(2026, 10, 12, 0, 5), NOW)).toBe('今天 00:05')
  })
  it('shows month and day this year, and the year before that', () => {
    expect(formatRelativeTime(at(2026, 10, 3, 9), NOW)).toBe('10 月 3 日')
    expect(formatRelativeTime(at(2026, 10, 11, 23, 59), NOW)).toBe('10 月 11 日')
    expect(formatRelativeTime(at(2025, 12, 3), NOW)).toBe('2025 年 12 月 3 日')
  })
  it('defaults now to the current time', () => {
    expect(formatRelativeTime(Date.now())).toBe('刚刚')
  })
})

describe('formatAgo (status lines)', () => {
  it('covers seconds, minutes, hours and days', () => {
    expect(formatAgo(NOW - 2_000, NOW)).toBe('刚刚')
    expect(formatAgo(NOW - 25_000, NOW)).toBe('25 秒前')
    expect(formatAgo(NOW - 3 * 60_000, NOW)).toBe('3 分钟前')
    expect(formatAgo(NOW - 2 * 3_600_000, NOW)).toBe('2 小时前')
    expect(formatAgo(NOW - 3 * 86_400_000, NOW)).toBe('3 天前')
    expect(formatAgo(Date.now())).toBe('刚刚')
  })
})

describe('timestamps and dates', () => {
  it('formats the full tooltip timestamp and the clock', () => {
    expect(formatFullTimestamp(new Date(2026, 9, 3, 18, 9, 5).getTime())).toBe('2026 年 10 月 3 日 18:09:05')
    expect(formatClock(new Date(2026, 0, 1, 7, 3))).toBe('07:03')
  })
  it('formats dates with the year only when it differs', () => {
    expect(formatDate(at(2026, 10, 7), NOW)).toBe('10 月 7 日')
    expect(formatDate(at(2024, 2, 29), NOW)).toBe('2024 年 2 月 29 日')
    expect(formatDate(Date.now())).toMatch(/月 \d+ 日$/)
  })
})

describe('counts (99+ cap)', () => {
  it('caps above 99', () => {
    expect(formatCount(0)).toBe('0')
    expect(formatCount(7)).toBe('7')
    expect(formatCount(99)).toBe('99')
    expect(formatCount(100)).toBe('99+')
    expect(formatCount(128)).toBe('99+')
    expect(formatCount(12.7)).toBe('12')
    expect(formatCount(1000, 999)).toBe('999+')
  })
  it('treats negatives and NaN as zero', () => {
    expect(formatCount(-3)).toBe('0')
    expect(formatCount(Number.NaN)).toBe('0')
  })
  it('formats +N overflow, capped', () => {
    expect(formatOverflow(0)).toBe('')
    expect(formatOverflow(-1)).toBe('')
    expect(formatOverflow(5)).toBe('+5')
    expect(formatOverflow(99)).toBe('+99')
    expect(formatOverflow(236)).toBe('99+')
  })
})

describe('failReasonText (§8)', () => {
  it('maps each reason to plain words', () => {
    expect(failReasonText('not_in_room')).toBe('你们俩已经不在同一个房间了')
    expect(failReasonText('target_lost')).toBe('对方断开了，没答完')
    expect(failReasonText('expired')).toBe('一天没人答，过期了')
    expect(failReasonText('no_reply')).toBe('对方结束了这一轮，但没回答')
  })
  it('uses the agent text for declined, with a fallback', () => {
    expect(failReasonText('declined', '  没权限  ')).toBe('没权限')
    expect(failReasonText('declined', '   ')).toBe('对方没有说原因')
    expect(failReasonText('declined')).toBe('对方没有说原因')
  })
  it('has a generic text for a missing reason', () => {
    expect(failReasonText(undefined)).toBe(UNKNOWN_REASON_TEXT)
  })
})

describe('truncation', () => {
  it('truncates at the end by code point', () => {
    expect(truncateEnd('an.extremely.long.address', 20)).toBe('an.extremely.long.a…')
    expect(truncateEnd('short', 10)).toBe('short')
    expect(truncateEnd('😀😀😀😀', 3)).toBe('😀😀…')
    expect(truncateEnd('abc', 0)).toBe('')
    expect(truncateEnd('abc', 1)).toBe('a…')
  })
  it('truncates in the middle keeping both ends', () => {
    expect(truncateMiddle('a.very.long.username.example', 12)).toBe('a.very…ample')
    expect(truncateMiddle('short', 10)).toBe('short')
    expect(truncateMiddle('abcdef', 2)).toBe('a…')
    expect(truncateMiddle('abcdef', 0)).toBe('')
    expect(Array.from(truncateMiddle('支付中台退款链路联调', 5))).toHaveLength(5)
  })
  it('takes an uppercase initial', () => {
    expect(initialOf('gulei')).toBe('G')
    expect(initialOf('  张伟')).toBe('张')
    expect(initialOf('')).toBe('?')
  })
})
