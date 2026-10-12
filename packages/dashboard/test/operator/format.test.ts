import { describe, expect, it } from 'bun:test'
import { ApiError } from '../../src/api/errors'
import {
  adminErrorText,
  formatDuration,
  isLoopbackUrl,
  publicUrlProblem,
} from '../../src/routes/operator/format'
import { copyText, matchMember, matchRoom, roomLabel, settingsPatch } from '../../src/routes/operator/logic'
import { adminMember, adminRoom, SETTINGS } from './fixtures'

describe('operator formatting', () => {
  it('formats durations with the two largest units', () => {
    expect(formatDuration(-5)).toBe('0 秒')
    expect(formatDuration(Number.NaN)).toBe('0 秒')
    expect(formatDuration(45_000)).toBe('45 秒')
    expect(formatDuration(12 * 60_000 + 5_000)).toBe('12 分钟')
    expect(formatDuration(3 * 3_600_000 + 5 * 60_000)).toBe('3 小时 5 分钟')
    expect(formatDuration(30 * 86_400_000)).toBe('30 天')
    expect(formatDuration(2 * 86_400_000 + 4 * 3_600_000 + 60_000)).toBe('2 天 4 小时')
  })
  it('spots loopback URLs', () => {
    expect(isLoopbackUrl('http://127.0.0.1:7337')).toBe(true)
    expect(isLoopbackUrl('http://localhost:7337')).toBe(true)
    expect(isLoopbackUrl('https://peers.example.com')).toBe(false)
    expect(isLoopbackUrl('not a url')).toBe(false)
    expect(isLoopbackUrl(null)).toBe(false)
    expect(isLoopbackUrl('')).toBe(false)
  })
  it('explains unusable public URLs', () => {
    expect(publicUrlProblem('')).toContain('填一个地址')
    expect(publicUrlProblem('peers.example.com')).toContain('http://')
    expect(publicUrlProblem('https://user:pw@peers.example.com')).toContain('用不了')
    expect(publicUrlProblem('https://peers.example.com/?x=1')).toContain('用不了')
    expect(publicUrlProblem(' https://peers.example.com ')).toBeUndefined()
  })
  it('words admin errors for the operator', () => {
    expect(adminErrorText(new ApiError('unauthorized', 'x', 401))).toContain('令牌不对')
    expect(adminErrorText(new ApiError('target_not_found', 'x', 404))).toContain('没找到')
    expect(adminErrorText(new ApiError('forbidden', 'x', 403))).toContain('hub 这台机器')
    expect(adminErrorText(new ApiError('disconnected', 'x', 0))).toContain('连不上 Core')
    expect(adminErrorText(new Error('boom'))).toBe('Core 出了点问题，稍后再试。')
  })
  it('builds a settings patch of changed fields only', () => {
    expect(settingsPatch(SETTINGS, ' https://peers.example.com ', 'invite-only')).toEqual({})
    expect(settingsPatch(SETTINGS, 'https://x.example', 'open')).toEqual({
      public_url: 'https://x.example',
      registration: 'open',
    })
    expect(settingsPatch({ ...SETTINGS, public_url: null }, '', 'invite-only')).toEqual({})
  })
  it('matches rooms and members for search', () => {
    const pay = adminRoom('r_pay', 'pay', {
      room: { room_id: 'r_pay', name: 'pay', display_name: '支付联调' },
    })
    expect(roomLabel(pay.room)).toBe('支付联调')
    expect(matchRoom(pay, '支付')).toBe(true)
    expect(matchRoom(pay, 'pay')).toBe(true)
    expect(matchRoom(pay, 'gulei')).toBe(false)
    expect(matchRoom(adminRoom('r', 'timely'), 'gulei')).toBe(true)
    expect(matchMember(adminMember('m', 'zhang-wei'), 'wei')).toBe(true)
    expect(matchMember(adminMember('m', 'zhang-wei'), 'li')).toBe(false)
  })
  it('reports clipboard failures instead of throwing', async () => {
    const original = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: { clipboard: { writeText: async () => Promise.reject(new Error('denied')) } },
    })
    try {
      expect(await copyText('x')).toBe(false)
    } finally {
      if (original !== undefined) Object.defineProperty(globalThis, 'navigator', original)
    }
  })
})
