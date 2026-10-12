import { afterAll, describe, expect, it } from 'bun:test'
import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { buildRelease } from '../../packages/cli/scripts/release/build'
import { parseSums, SUMS_FILE, sha256File } from '../../packages/cli/scripts/release/checksums'
import { assetName, currentTarget } from '../../packages/cli/scripts/release/targets'
import { cleanupDirs, currentBinary, isolatedEnv, REPO_ROOT, runProcess, tempDir } from './helpers'

afterAll(cleanupDirs)

describe('release build (current platform)', () => {
  it('compiles agent-peers-<os>-<arch> and a matching SHA256SUMS', async () => {
    const { dir, result } = await currentBinary()
    const target = currentTarget()
    const binary = join(dir, assetName(target))
    expect(result.artifacts.map((a) => a.path)).toEqual([binary])
    expect(result.sums).toBe(join(dir, SUMS_FILE))
    expect(((await stat(binary)).mode & 0o111) !== 0).toBe(true)
    const sums = parseSums(await readFile(join(dir, SUMS_FILE), 'utf8'))
    expect(sums).toEqual([{ name: assetName(target), sha256: await sha256File(binary) }])
  }, 120_000)

  it('runs --version and an MCP selftest without Node or Bun on PATH', async () => {
    const { dir } = await currentBinary()
    const binary = join(dir, assetName(currentTarget()))
    const home = await tempDir()
    const env = { PATH: '/usr/bin:/bin', HOME: home, AGENT_PEERS_HOME: join(home, '.agent-peers') }
    const version = await runProcess([binary, '--version'], env)
    expect(version.code).toBe(0)
    const pkg = JSON.parse(await readFile(join(REPO_ROOT, 'packages', 'cli', 'package.json'), 'utf8'))
    expect(version.stdout.trim()).toBe(pkg.version)
    const selftest = await runProcess([binary, 'mcp', '--surface', 'claude-code', '--selftest'], env)
    // stdout is the MCP channel, so the selftest reports on stderr.
    expect(selftest.code).toBe(0)
    expect(selftest.stdout).toBe('')
    expect(selftest.stderr).toContain('selftest ok (claude-code)')
  }, 120_000)

  it('writes a single dev binary to --outfile without SHA256SUMS', async () => {
    const out = await tempDir()
    const outfile = join(out, 'nested', 'agent-peers')
    const lines: string[] = []
    const result = await buildRelease({
      repoRoot: REPO_ROOT,
      outDir: join(out, 'release'),
      targets: [currentTarget()],
      dashboard: 'skip',
      adapters: 'check',
      minify: false,
      sourcemap: false,
      outfile,
      log: (line) => lines.push(line),
    })
    expect(result).toEqual({ artifacts: [{ target: currentTarget(), path: outfile }] })
    expect(await Bun.file(join(out, 'release', SUMS_FILE)).exists()).toBe(false)
    expect(lines.some((line) => line.includes('up to date'))).toBe(true)
    const ran = await runProcess([outfile, 'version', '--json'], isolatedEnv(out))
    expect(JSON.parse(ran.stdout).platform).toBe(`${process.platform}-${process.arch}`)
  }, 120_000)

  it('refuses --outfile with several targets, and an empty target list', async () => {
    const base = {
      repoRoot: REPO_ROOT,
      outDir: await tempDir(),
      dashboard: 'skip' as const,
      adapters: 'skip' as const,
      minify: false,
      sourcemap: false,
    }
    await expect(buildRelease({ ...base, targets: [] })).rejects.toThrow('no targets')
    const two = [currentTarget(), currentTarget()]
    await expect(buildRelease({ ...base, targets: two, outfile: join(base.outDir, 'x') })).rejects.toThrow(
      'exactly one target',
    )
  })

  it('reports a failed compile with the bun output', async () => {
    // `sh build <entry> …` fails: there is no script named "build".
    await expect(
      buildRelease({
        repoRoot: REPO_ROOT,
        outDir: await tempDir(),
        targets: [currentTarget()],
        dashboard: 'skip',
        adapters: 'skip',
        minify: false,
        sourcemap: false,
        bun: '/bin/sh',
      }),
    ).rejects.toThrow(`bun build failed for ${currentTarget().id}`)
  })
})

/** Reads the first stdout line of a long-running process, then leaves it running. */
async function firstLine(proc: Bun.Subprocess<'ignore', 'pipe', 'pipe'>): Promise<string> {
  const reader = proc.stdout.getReader()
  let text = ''
  while (!text.includes('\n')) {
    const { done, value } = await reader.read()
    if (done) break
    text += new TextDecoder().decode(value)
  }
  reader.releaseLock()
  return text.split('\n')[0] ?? ''
}

describe('release build with a dashboard', () => {
  it('embeds the dashboard module in the binary and the hub serves it at /app', async () => {
    const dir = await tempDir()
    await Bun.write(join(dir, 'dash', 'index.html'), '<!doctype html><title>embedded dashboard</title>')
    await Bun.write(
      join(dir, 'dash', 'index.ts'),
      [
        "import page from './index.html' with { type: 'file' }",
        "export const dashboardAssets = () => new Map([['index.html', Bun.file(page)]])",
        '',
      ].join('\n'),
    )
    const outfile = join(dir, 'agent-peers')
    await buildRelease({
      repoRoot: REPO_ROOT,
      outDir: join(dir, 'out'),
      targets: [currentTarget()],
      dashboard: 'embed',
      dashboardModule: join(dir, 'dash', 'index.ts'),
      adapters: 'skip',
      minify: true,
      sourcemap: false,
      outfile,
    })
    // The source module is gone at run time: the binary must carry the page itself.
    await Bun.write(join(dir, 'dash', 'index.html'), 'changed on disk')
    const home = join(dir, 'home')
    const argv = [outfile, '--json', 'hub', '--port', '0', '--admin-port', '0', '--bind', '127.0.0.1']
    const proc = Bun.spawn([...argv, '--data-dir', join(home, 'hub')], {
      env: isolatedEnv(home, { AGENT_PEERS_HOME: home }),
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
    })
    try {
      const started = JSON.parse(await firstLine(proc))
      expect(started.dashboard).toBe(true)
      const page = await fetch(`http://127.0.0.1:${started.publicPort}/app/`)
      expect(page.status).toBe(200)
      expect(await page.text()).toContain('embedded dashboard')
    } finally {
      proc.kill('SIGTERM')
      await proc.exited
    }
  }, 120_000)
})
