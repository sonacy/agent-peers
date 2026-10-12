import { afterAll, describe, expect, it } from 'bun:test'
import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { parseStageArgs } from '../../packages/cli/scripts/npm-stage'
import { writeSums } from '../../packages/cli/scripts/release/checksums'
import {
  cliVersion,
  fillTemplate,
  releaseVersion,
  stageNpm,
} from '../../packages/cli/scripts/release/npm-stage'
import { assetName, RELEASE_TARGETS } from '../../packages/cli/scripts/release/targets'
import { cleanupDirs, REPO_ROOT, tempDir } from './helpers'

afterAll(cleanupDirs)

/** A dist/release dir with a small fake binary per target (and SHA256SUMS unless `sums` is false). */
async function fakeRelease(sums = true): Promise<string> {
  const dir = await tempDir()
  const files = RELEASE_TARGETS.map((t) => join(dir, assetName(t)))
  for (const [i, file] of files.entries()) await Bun.write(file, `binary ${RELEASE_TARGETS[i]?.id}`)
  if (sums) await writeSums(dir, files)
  return dir
}

const readJson = async (path: string) => JSON.parse(await readFile(path, 'utf8'))

describe('npm staging', () => {
  it('stages five platform packages and the launcher, all at the release version', async () => {
    const out = join(await tempDir(), 'npm')
    const staged = await stageNpm({
      repoRoot: REPO_ROOT,
      releaseDir: await fakeRelease(),
      outDir: out,
      version: '1.2.3',
    })
    expect(staged.map((p) => p.name)).toEqual([
      '@agent-peers/cli-darwin-arm64',
      '@agent-peers/cli-darwin-x64',
      '@agent-peers/cli-linux-x64',
      '@agent-peers/cli-linux-arm64',
      '@agent-peers/cli-win32-x64',
      '@agent-peers/cli',
    ])
    const win = await readJson(join(out, 'cli-win32-x64', 'package.json'))
    expect(win).toMatchObject({
      name: '@agent-peers/cli-win32-x64',
      version: '1.2.3',
      os: ['win32'],
      cpu: ['x64'],
    })
    expect(await Bun.file(join(out, 'cli-win32-x64', 'bin', 'agent-peers.exe')).text()).toBe(
      'binary windows-x64',
    )
    const linuxBin = join(out, 'cli-linux-arm64', 'bin', 'agent-peers')
    expect((await stat(linuxBin)).mode & 0o777).toBe(0o755)
    expect(await Bun.file(join(out, 'cli-linux-arm64', 'README.md')).text()).toContain(
      '# @agent-peers/cli-linux-arm64',
    )
    const launcher = await readJson(join(out, 'cli', 'package.json'))
    expect(launcher.name).toBe('@agent-peers/cli')
    expect(launcher.version).toBe('1.2.3')
    expect(launcher.bin).toEqual({ 'agent-peers': 'bin/agent-peers.js' })
    expect(Object.values(launcher.optionalDependencies)).toEqual(Array(5).fill('1.2.3'))
    expect(Object.keys(launcher.optionalDependencies)).toEqual(staged.slice(0, 5).map((p) => p.name))
    for (const file of ['bin/agent-peers.js', 'lib/platform.js', 'lib/run.js', 'README.md']) {
      expect(await Bun.file(join(out, 'cli', file)).exists()).toBe(true)
    }
    expect((await stat(join(out, 'cli', 'bin', 'agent-peers.js'))).mode & 0o111).not.toBe(0)
  })

  it('refuses binaries that do not match SHA256SUMS, missing binaries and non-semver versions', async () => {
    const releaseDir = await fakeRelease()
    await Bun.write(join(releaseDir, 'agent-peers-linux-x64'), 'tampered')
    const outDir = join(await tempDir(), 'npm')
    await expect(stageNpm({ repoRoot: REPO_ROOT, releaseDir, outDir, version: '1.0.0' })).rejects.toThrow(
      'agent-peers-linux-x64 does not match SHA256SUMS',
    )
    const empty = await tempDir()
    await expect(
      stageNpm({ repoRoot: REPO_ROOT, releaseDir: empty, outDir, version: '1.0.0' }),
    ).rejects.toThrow('missing release binary')
    await expect(stageNpm({ repoRoot: REPO_ROOT, releaseDir: empty, outDir, version: 'v1' })).rejects.toThrow(
      'version must be semver',
    )
  })

  it('stages without SHA256SUMS and for a subset of targets', async () => {
    const outDir = join(await tempDir(), 'npm')
    const targets = RELEASE_TARGETS.slice(0, 1)
    const staged = await stageNpm({
      repoRoot: REPO_ROOT,
      releaseDir: await fakeRelease(false),
      outDir,
      version: '0.0.1',
      targets,
    })
    expect(staged.map((p) => p.name)).toEqual(['@agent-peers/cli-darwin-arm64', '@agent-peers/cli'])
    expect(Object.keys((await readJson(join(outDir, 'cli', 'package.json'))).optionalDependencies)).toEqual([
      '@agent-peers/cli-darwin-arm64',
    ])
  })

  it('fills the platform template', () => {
    const target = RELEASE_TARGETS[4]
    if (target === undefined) throw new Error('no target')
    expect(fillTemplate('{{platform}}/{{arch}} {{platform}}', target)).toBe('win32/x64 win32')
  })

  it('takes the version from packages/cli and refuses a mismatched tag', async () => {
    const version = await cliVersion(REPO_ROOT)
    expect(releaseVersion(undefined, version)).toBe(version)
    expect(releaseVersion(`v${version}`, version)).toBe(version)
    expect(() => releaseVersion('v99.0.0', version)).toThrow(`release version 99.0.0 != packages/cli`)
    const options = await parseStageArgs(['--release', 'r', '--out', 'o', '--targets', 'linux-x64'], '/w')
    expect(options).toMatchObject({ releaseDir: '/w/r', outDir: '/w/o', version })
    expect(options.targets?.map((t) => t.id)).toEqual(['linux-x64'])
    const defaults = await parseStageArgs([])
    expect(defaults.releaseDir).toBe(join(REPO_ROOT, 'dist', 'release'))
    expect(defaults.outDir).toBe(join(REPO_ROOT, 'dist', 'npm'))
  })

  it('keeps the launcher template on placeholder versions and in sync with the targets', async () => {
    const launcher = await readJson(join(REPO_ROOT, 'npm', 'cli', 'package.json'))
    expect(launcher.version).toBe('0.0.0-dev')
    expect(launcher.private).toBeUndefined()
    expect(Object.keys(launcher.optionalDependencies)).toEqual(
      RELEASE_TARGETS.map((t) => `@agent-peers/cli-${t.nodePlatform}-${t.arch}`),
    )
    const cli = await readJson(join(REPO_ROOT, 'packages', 'cli', 'package.json'))
    expect(cli).toMatchObject({ name: '@agent-peers/cli-app', private: true })
  })
})
