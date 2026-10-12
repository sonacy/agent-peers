import { afterAll, describe, expect, it, spyOn } from 'bun:test'
import { join } from 'node:path'
import { parseReleaseArgs } from '../../packages/cli/scripts/release'
import { prepareDashboard, type ReleaseOptions } from '../../packages/cli/scripts/release/build'
import { parseSums, renderSums, writeSums } from '../../packages/cli/scripts/release/checksums'
import { compileArgv } from '../../packages/cli/scripts/release/compile'
import { EXIT_GRACE_MS, renderEntry, writeEntry } from '../../packages/cli/scripts/release/entry'
import { bundledDashboard, releaseDeps, runRelease } from '../../packages/cli/scripts/release/runtime'
import {
  assetName,
  currentTarget,
  npmBinaryName,
  npmPackageName,
  parseTargets,
  RELEASE_TARGETS,
  targetFor,
} from '../../packages/cli/scripts/release/targets'
import { memoryIo } from '../../packages/cli/test/helpers/world'
import { cleanupDirs, REPO_ROOT, sha256, tempDir, writeExecutable } from './helpers'

afterAll(cleanupDirs)

const byId = (id: string) => {
  const found = RELEASE_TARGETS.find((t) => t.id === id)
  if (found === undefined) throw new Error(id)
  return found
}

describe('release targets', () => {
  it('covers the five ARCHITECTURE §9 targets with asset and npm names', () => {
    expect(RELEASE_TARGETS.map((t) => t.bunTarget)).toEqual([
      'bun-darwin-arm64',
      'bun-darwin-x64-baseline',
      'bun-linux-x64-baseline',
      'bun-linux-arm64',
      'bun-windows-x64-baseline',
    ])
    expect(RELEASE_TARGETS.map(assetName)).toEqual([
      'agent-peers-darwin-arm64',
      'agent-peers-darwin-x64',
      'agent-peers-linux-x64',
      'agent-peers-linux-arm64',
      'agent-peers-windows-x64.exe',
    ])
    expect(RELEASE_TARGETS.map(npmPackageName)).toEqual([
      '@agent-peers/cli-darwin-arm64',
      '@agent-peers/cli-darwin-x64',
      '@agent-peers/cli-linux-x64',
      '@agent-peers/cli-linux-arm64',
      '@agent-peers/cli-win32-x64',
    ])
    expect(npmBinaryName(byId('windows-x64'))).toBe('agent-peers.exe')
    expect(npmBinaryName(byId('linux-arm64'))).toBe('agent-peers')
  })

  it('maps process.platform/arch to a target', () => {
    expect(targetFor('win32', 'x64')?.id).toBe('windows-x64')
    expect(targetFor('linux', 'ia32')).toBeUndefined()
    expect(currentTarget('darwin', 'arm64').id).toBe('darwin-arm64')
    expect(() => currentTarget('freebsd', 'x64')).toThrow('no release target for freebsd-x64')
  })

  it('parses --targets lists in release order', () => {
    expect(parseTargets('all')).toBe(RELEASE_TARGETS)
    expect(parseTargets(' , ')).toBe(RELEASE_TARGETS)
    expect(parseTargets('linux-x64, darwin-arm64').map((t) => t.id)).toEqual(['darwin-arm64', 'linux-x64'])
    expect(() => parseTargets('linux-x64,plan9-x64')).toThrow('unknown target plan9-x64')
  })
})

describe('SHA256SUMS', () => {
  it('renders sorted sha256sum lines and parses both spellings', () => {
    const a = sha256('a')
    const b = sha256('b')
    const text = renderSums([
      { name: 'z-bin', sha256: b },
      { name: 'a-bin', sha256: a },
    ])
    expect(text).toBe(`${a}  a-bin\n${b}  z-bin\n`)
    expect(parseSums(`${text}${a} *star\n\n`)).toEqual([
      { sha256: a, name: 'a-bin' },
      { sha256: b, name: 'z-bin' },
      { sha256: a, name: 'star' },
    ])
    expect(() => parseSums('nope  file\n')).toThrow('bad SHA256SUMS line')
  })

  it('hashes files into <dir>/SHA256SUMS', async () => {
    const dir = await tempDir()
    await Bun.write(join(dir, 'one'), 'hello')
    const sums = await writeSums(dir, [join(dir, 'one')])
    expect(sums).toEqual([{ name: 'one', sha256: sha256('hello') }])
    expect(await Bun.file(join(dir, 'SHA256SUMS')).text()).toBe(`${sha256('hello')}  one\n`)
  })
})

describe('release entry and compile argv', () => {
  it('imports the dashboard statically only when there is one', async () => {
    const without = renderEntry({ runtime: '/repo/runtime.ts' })
    expect(without).toContain('import { runRelease } from "/repo/runtime.ts"')
    expect(without).not.toContain('dashboard')
    expect(without).toContain(`process.exit(code), ${EXIT_GRACE_MS}`)
    const dir = await tempDir()
    const path = await writeEntry(join(dir, 'nested'), { runtime: '/r.ts', dashboard: '/d/index.ts' })
    const text = await Bun.file(path).text()
    expect(text).toContain('import * as dashboard from "/d/index.ts"')
    expect(text).toContain('runRelease(process.argv.slice(2), dashboard)')
  })

  it('builds the bun build --compile argv', () => {
    const target = byId('linux-arm64')
    const base = { entry: 'e.ts', target, outfile: 'out', bun: 'bun' }
    expect(compileArgv({ ...base, minify: true, sourcemap: true })).toEqual([
      'bun',
      'build',
      'e.ts',
      '--compile',
      '--target=bun-linux-arm64',
      '--outfile',
      'out',
      '--minify',
      '--sourcemap',
    ])
    expect(compileArgv({ ...base, minify: false, sourcemap: false }).slice(-2)).toEqual(['--outfile', 'out'])
    // x64 compiles Bun's baseline (no AVX2) runtime: VPS CPU models and Rosetta 2 lack AVX2.
    expect(compileArgv({ ...base, target: byId('linux-x64'), minify: false, sourcemap: false })).toContain(
      '--target=bun-linux-x64-baseline',
    )
    expect(compileArgv({ entry: 'e', target, outfile: 'o', minify: false, sourcemap: false })[0]).toBe(
      process.execPath,
    )
  })
})

describe('release.ts arguments', () => {
  it('defaults to every target, dist/release, a fresh dashboard and minified sourcemapped binaries', () => {
    const options = parseReleaseArgs([])
    expect(options.targets).toBe(RELEASE_TARGETS)
    expect(options.outDir).toBe(join(REPO_ROOT, 'dist', 'release'))
    expect(options).toMatchObject({ dashboard: 'build', adapters: 'write', minify: true, sourcemap: true })
    expect(options.outfile).toBeUndefined()
  })

  it('--current builds this platform and embeds the last dashboard build', () => {
    const options = parseReleaseArgs(
      ['--current', '--outfile', 'dist/agent-peers', '--out', 'o', '--no-minify', '--no-sourcemap'],
      '/work',
    )
    expect(options.targets).toEqual([currentTarget()])
    expect(options).toMatchObject({
      dashboard: 'embed',
      outfile: '/work/dist/agent-peers',
      outDir: '/work/o',
      minify: false,
      sourcemap: false,
    })
    expect(
      parseReleaseArgs(['--targets', 'linux-x64', '--dashboard', 'skip', '--adapters', 'check']),
    ).toMatchObject({ dashboard: 'skip', adapters: 'check' })
  })

  it('logs progress lines to stdout', () => {
    const write = spyOn(process.stdout, 'write').mockImplementation(() => true)
    try {
      parseReleaseArgs([]).log?.('built agent-peers-linux-x64')
      expect(write).toHaveBeenCalledWith('built agent-peers-linux-x64\n')
    } finally {
      write.mockRestore()
    }
  })

  it('rejects unknown modes and flags', () => {
    expect(() => parseReleaseArgs(['--dashboard', 'maybe'])).toThrow(
      '--dashboard must be one of build, embed, skip',
    )
    expect(() => parseReleaseArgs(['--adapters', 'x'])).toThrow('--adapters must be one of')
    expect(() => parseReleaseArgs(['--bogus'])).toThrow()
  })
})

describe('release runtime', () => {
  it('hands a bundled dashboard module to the hub command', async () => {
    const assets = new Map([['index.html', new Blob(['<html>'])]])
    const warnings: string[] = []
    const loaded = await bundledDashboard({ dashboardAssets: () => assets })((m) => warnings.push(m))
    expect(loaded).toEqual(assets)
    const broken = await bundledDashboard({
      dashboardAssets: () => {
        throw new Error('boom')
      },
    })((m) => warnings.push(m))
    expect(broken).toBeUndefined()
    expect(warnings).toEqual(['dashboard assets failed to load: Error: boom'])
    expect(await bundledDashboard({})(() => undefined)).toBeUndefined()
    expect(releaseDeps(undefined)).toEqual({})
    expect(releaseDeps({}).hub?.run?.loadDashboard).toBeFunction()
  })

  it('runs the CLI', async () => {
    const io = memoryIo({ AGENT_PEERS_HOME: await tempDir() })
    expect(await runRelease(['version', '--json'], { dashboardAssets: () => undefined }, io)).toBe(0)
    expect(JSON.parse(io.out.join('')).platform).toBe(`${process.platform}-${process.arch}`)
  })
})

describe('dashboard preparation', () => {
  async function fakeRepo(buildScript: string | undefined): Promise<ReleaseOptions> {
    const repoRoot = await tempDir()
    if (buildScript !== undefined) {
      const dir = join(repoRoot, 'packages', 'dashboard')
      await Bun.write(join(dir, 'src', 'index.ts'), 'export const dashboardAssets = () => undefined\n')
      await Bun.write(
        join(dir, 'package.json'),
        JSON.stringify({ name: 'd', scripts: { build: buildScript } }),
      )
      await writeExecutable(
        join(dir, 'build.sh'),
        '#!/bin/sh\necho "$1" > built.txt\necho "dashboard: 3 files"\n',
      )
    }
    return {
      repoRoot,
      outDir: join(repoRoot, 'out'),
      targets: [],
      dashboard: 'build',
      adapters: 'skip',
      minify: false,
      sourcemap: false,
    }
  }

  it('builds, embeds or skips the dashboard package', async () => {
    const lines: string[] = []
    const options = { ...(await fakeRepo('sh build.sh ok')), log: (line: string) => lines.push(line) }
    const index = join(options.repoRoot, 'packages', 'dashboard', 'src', 'index.ts')
    expect(await prepareDashboard(options)).toBe(index)
    expect(await Bun.file(join(options.repoRoot, 'packages', 'dashboard', 'built.txt')).text()).toBe('ok\n')
    expect(lines).toEqual(['dashboard: 3 files'])
    expect(await prepareDashboard({ ...options, dashboard: 'embed' })).toBe(index)
    expect(await prepareDashboard({ ...options, dashboard: 'skip' })).toBeUndefined()
  })

  it('builds without a dashboard package, and fails on a failed dashboard build', async () => {
    const lines: string[] = []
    const absent = { ...(await fakeRepo(undefined)), log: (line: string) => lines.push(line) }
    expect(await prepareDashboard(absent)).toBeUndefined()
    expect(lines).toEqual(['dashboard: package not present, building without it'])
    const failing = await fakeRepo('echo broken >&2; exit 4')
    await expect(prepareDashboard(failing)).rejects.toThrow('dashboard build failed (exit 4)')
  })
})
