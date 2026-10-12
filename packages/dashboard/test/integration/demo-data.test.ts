import { describe, expect, it } from 'bun:test'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { silentLogger } from '@agent-peers/hub'
import { isValidName } from '@agent-peers/protocol'
import { createDemoClock, DAY, HOUR } from '../../scripts/demo/clock'
import { bigRoomAgents, generatedNames, MY_AGENTS, TEAM, TEAM_AGENTS } from '../../scripts/demo/data'
import { resolveSource, startDemoHub } from '../../scripts/demo/hub'
import { assertDemoOptions, DEFAULT_DEMO_OPTIONS } from '../../scripts/demo/seed'

describe('demo clock', () => {
  it('sets hub time back and only moves forward', () => {
    let now = 1_000_000_000
    const demo = createDemoClock(() => now)
    expect(demo.clock.now()).toBe(now)
    demo.at(DAY)
    expect(demo.clock.now()).toBe(now - DAY)
    expect(demo.offsetMs).toBe(DAY)
    demo.at(HOUR)
    now += 5
    expect(demo.clock.now()).toBe(now - HOUR)
    expect(() => demo.at(DAY)).toThrow('only moves forward')
    expect(() => demo.at(-1)).toThrow('bad offset')
    demo.present()
    expect(demo.clock.now()).toBe(now)
    expect(() => demo.at(1)).toThrow('only moves forward')
  })
  it('uses real timers', async () => {
    const demo = createDemoClock()
    const fired = await new Promise<boolean>((resolve) => {
      const handle = demo.clock.setTimeout(() => resolve(false), 5)
      demo.clock.clearTimeout(handle)
      demo.clock.setTimeout(() => resolve(true), 1)
    })
    expect(fired).toBe(true)
  })
})

describe('demo cast', () => {
  it('uses valid, distinct member names', () => {
    const names = [...TEAM, ...generatedNames(300), ...generatedNames(150, 'new-')]
    expect(names.every(isValidName)).toBe(true)
    expect(new Set(names).size).toBe(names.length)
  })
  it('gives every big-room member two agents with a kind-appropriate tier', () => {
    const agents = Array.from({ length: 12 }, (_, i) => bigRoomAgents(i)).flat()
    expect(agents).toHaveLength(24)
    for (const agent of agents) {
      if (agent.kind === 'claude-desktop') expect(agent.inject).toBe('poll')
      if (agent.kind === 'cursor' || agent.kind === 'trae') expect(agent.inject).toBe('boundary')
    }
    expect(new Set(agents.map((a) => a.kind)).size).toBeGreaterThan(4)
  })
  it('matches the mockup titles', () => {
    expect(Object.values(MY_AGENTS).map((a) => a.title)).toEqual([
      '通用插件将 agent session 同步',
      '调研 T3Code 项目',
      'Recent popular agent projects',
      'prd2demo',
    ])
    expect(Object.keys(TEAM_AGENTS).length).toBeGreaterThan(4)
  })
})

describe('demo hub setup', () => {
  it('validates the big-room counts', () => {
    expect(() => assertDemoOptions(DEFAULT_DEMO_OPTIONS)).not.toThrow()
    expect(() => assertDemoOptions({ ...DEFAULT_DEMO_OPTIONS, bigRoomKnocks: -1 })).toThrow('non-negative')
    expect(() => assertDemoOptions({ ...DEFAULT_DEMO_OPTIONS, bigRoomOnline: 500 })).toThrow('seats')
  })
  it('stops the hub again when seeding fails', async () => {
    const source = { assets: new Map([['index.html', '<p>demo</p>']]) }
    const failed = startDemoHub({ source, logger: silentLogger, bigRoomMembers: 1.5 })
    await expect(failed).rejects.toThrow('non-negative integers')
  })
  it('serves the embedded build, or builds one into a temp dir', async () => {
    const resolved = await resolveSource()
    const { dir, assets } = resolved.source
    if (assets instanceof Map) expect(assets.has('index.html')).toBe(true)
    else expect(existsSync(join(dir ?? '', 'index.html'))).toBe(true)
    await resolved.cleanup()
    if (dir !== undefined) expect(existsSync(dir)).toBe(false)
  }, 60_000)
})

describe('demo script', () => {
  it('starts, prints its URLs as JSON and stops on SIGTERM', async () => {
    const script = new URL('../../scripts/demo-hub.ts', import.meta.url).pathname
    const proc = Bun.spawn(
      [process.execPath, script, '--small', '--port', '0', '--admin-port', '0', '--json'],
      {
        stdout: 'pipe',
        stderr: 'pipe',
        stdin: 'pipe',
      },
    )
    const reader = proc.stdout.getReader()
    const { value } = await reader.read()
    const info = JSON.parse(new TextDecoder().decode(value).split('\n')[0] ?? '{}') as Record<string, string>
    expect(info.loginUrl).toContain('/app/login?c=')
    expect(info.adminUrl).toEndWith('/admin/')
    expect((await fetch(info.loginUrl ?? '')).status).toBe(200)
    proc.stdin.write('\n')
    await proc.stdin.flush()
    const { value: next } = await reader.read()
    expect(new TextDecoder().decode(next)).toContain('loginUrl')
    reader.releaseLock()
    proc.kill('SIGTERM')
    expect(await proc.exited).toBe(0)
  }, 60_000)
})
