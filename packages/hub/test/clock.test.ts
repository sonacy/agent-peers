import { describe, expect, it, mock, spyOn } from 'bun:test'
import { guarded, systemClock } from '../src/clock'
import { consoleLogger, silentLogger } from '../src/config'

describe('systemClock', () => {
  it('reports wall-clock time', () => {
    const before = Date.now()
    const now = systemClock.now()
    expect(now).toBeGreaterThanOrEqual(before)
    expect(now).toBeLessThanOrEqual(Date.now())
  })

  it('runs a scheduled callback', async () => {
    const fired = await new Promise<boolean>((resolve) => {
      systemClock.setTimeout(() => resolve(true), 1)
    })
    expect(fired).toBe(true)
  })

  it('cancels a scheduled callback', async () => {
    const fn = mock(() => undefined)
    const handle = systemClock.setTimeout(fn, 5)
    systemClock.clearTimeout(handle)
    await Bun.sleep(20)
    expect(fn).not.toHaveBeenCalled()
  })
})

describe('guarded', () => {
  it('passes through when the callback succeeds', () => {
    const fn = mock(() => undefined)
    const logger = { error: mock(() => undefined) }
    guarded(logger, 'sweep', fn)()
    expect(fn).toHaveBeenCalledTimes(1)
    expect(logger.error).not.toHaveBeenCalled()
  })

  it('logs instead of throwing when the callback fails', () => {
    const boom = new Error('SQLITE_BUSY')
    const logger = { error: mock((_message: string, _error?: unknown) => undefined) }
    expect(() =>
      guarded(logger, 'sweep', () => {
        throw boom
      })(),
    ).not.toThrow()
    expect(logger.error).toHaveBeenCalledWith('sweep failed', boom)
  })
})

describe('loggers', () => {
  it('silentLogger discards everything', () => {
    expect(() => {
      silentLogger.info('a')
      silentLogger.warn('b')
      silentLogger.error('c', new Error('d'))
    }).not.toThrow()
  })

  it('consoleLogger prefixes messages with [hub]', () => {
    const info = spyOn(console, 'info').mockImplementation(() => undefined)
    const warn = spyOn(console, 'warn').mockImplementation(() => undefined)
    const error = spyOn(console, 'error').mockImplementation(() => undefined)
    try {
      consoleLogger.info('started')
      consoleLogger.warn('careful')
      consoleLogger.error('failed', 'why')
      consoleLogger.error('failed without detail')
      expect(info).toHaveBeenCalledWith('[hub] started')
      expect(warn).toHaveBeenCalledWith('[hub] careful')
      expect(error).toHaveBeenCalledWith('[hub] failed', 'why')
      expect(error).toHaveBeenCalledWith('[hub] failed without detail', '')
    } finally {
      info.mockRestore()
      warn.mockRestore()
      error.mockRestore()
    }
  })
})
