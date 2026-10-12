import { describe, expect, it } from 'bun:test'
import { consoleLogger, isMemoryDataDir, resolveConfig, resolvePublicUrl, silentLogger } from '../src/config'

describe('config', () => {
  it('applies protocol defaults', () => {
    const c = resolveConfig()
    expect(c.dataDir).toBe(':memory:')
    expect(c.publicPort).toBe(7337)
    expect(c.adminPort).toBe(7338)
    expect(c.adminBind).toBe('127.0.0.1')
    expect(c.heartbeatMs).toBe(15_000)
    expect(c.graceMs).toBe(90_000)
    expect(c.registration).toBe('invite-only')
    expect(c.messagesPerMinute).toBe(30)
    expect(c.allowRoomCreation).toBe(true)
    expect(isMemoryDataDir(c.dataDir)).toBe(true)
  })

  it('always allows room creation on open registration', () => {
    expect(resolveConfig({ registration: 'open', allowRoomCreation: false }).allowRoomCreation).toBe(true)
    expect(resolveConfig({ allowRoomCreation: false }).allowRoomCreation).toBe(false)
  })

  it('validates numbers and versions', () => {
    expect(() => resolveConfig({ heartbeatMs: 0 })).toThrow()
    expect(() => resolveConfig({ graceMs: -1 })).toThrow()
    expect(resolveConfig({ graceMs: 0 }).graceMs).toBe(0)
    expect(() => resolveConfig({ publicPort: 70000 })).toThrow()
    expect(() => resolveConfig({ version: 'v1' })).toThrow()
  })

  it('resolves the public URL', () => {
    expect(resolvePublicUrl(resolveConfig({ publicUrl: 'https://hub.example.com/' }), 1)).toBe(
      'https://hub.example.com',
    )
    expect(resolvePublicUrl(resolveConfig({ publicBind: '127.0.0.1' }), 4000)).toBe('http://127.0.0.1:4000')
    expect(resolvePublicUrl(resolveConfig({ publicBind: '::1' }), 4000)).toBe('http://[::1]:4000')
    expect(resolvePublicUrl(resolveConfig({ publicBind: '0.0.0.0' }), 4000)).toBeUndefined()
    expect(resolvePublicUrl(resolveConfig({ publicBind: '192.168.1.5' }), 4000)).toBeUndefined()
  })

  it('has quiet and console loggers', () => {
    silentLogger.info('x')
    silentLogger.warn('x')
    silentLogger.error('x')
    expect(typeof consoleLogger.info).toBe('function')
  })
})
