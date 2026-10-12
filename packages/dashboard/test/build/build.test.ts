/**
 * Integration: the real bundle (React + Tailwind + fonts) and its embedding in a compiled binary.
 * Builds into a temp dir, so the package's dist/ and generated module are untouched.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { listFiles } from '../../scripts/assets-module'
import { injectBootScript } from '../../scripts/boot-script'

const PACKAGE_DIR = join(import.meta.dir, '..', '..')
const INDEX_MODULE = join(PACKAGE_DIR, 'src', 'index.ts')

let work: string
let built: { readonly outdir: string; readonly files: readonly string[] }
let moduleFile: string

// The build runs as its own process, exactly like `bun run build` (see scripts/build-spa.ts).
beforeAll(async () => {
  work = await mkdtemp(join(tmpdir(), 'peers-build-'))
  const outdir = join(work, 'dist')
  moduleFile = join(work, 'gen', 'assets.ts')
  const proc = Bun.spawnSync(
    [process.execPath, join(PACKAGE_DIR, 'scripts', 'build.ts'), '--outdir', outdir, '--module', moduleFile],
    { stdout: 'pipe', stderr: 'pipe', stdin: 'ignore' },
  )
  if (proc.exitCode !== 0) throw new Error(`build failed: ${proc.stderr.toString()}`)
  built = { outdir, files: await listFiles(outdir) }
}, 120_000)

afterAll(async () => {
  await rm(work, { recursive: true, force: true })
})

describe('buildSpa', () => {
  it('emits html, js, css and self-hosted woff2 fonts', () => {
    expect(built.files).toContain('index.html')
    expect(built.files.some((f) => f.endsWith('.js'))).toBe(true)
    expect(built.files.some((f) => f.endsWith('.css'))).toBe(true)
    expect(built.files.filter((f) => f.endsWith('.woff2')).length).toBe(8)
  })
  it('references bundles under /app/ so deep SPA routes load them', async () => {
    const html = await readFile(join(built.outdir, 'index.html'), 'utf8')
    expect(html).toMatch(/<script type="module" crossorigin src="\/app\/[^"]+\.js">/)
    expect(html).toMatch(/<link rel="stylesheet" crossorigin href="\/app\/[^"]+\.css">/)
  })
  it('runs the boot script (zod jitless, no CSP eval probe) before the app bundle', async () => {
    const html = await readFile(join(built.outdir, 'index.html'), 'utf8')
    const boot = html.indexOf('<script src="/app/boot-')
    expect(boot).toBeGreaterThan(-1)
    expect(boot).toBeLessThan(html.indexOf('<script type="module"'))
    const file = built.files.find((f) => f.startsWith('boot-') && f.endsWith('.js'))
    expect(await readFile(join(built.outdir, file ?? 'missing'), 'utf8')).toContain('jitless')
  })
  it("stays inside CSP default-src 'self': no inline scripts or data: fonts", async () => {
    const html = await readFile(join(built.outdir, 'index.html'), 'utf8')
    expect(html).not.toMatch(/<script(?![^>]*\ssrc=)[^>]*>/)
    expect(html).not.toContain('<style')
    for (const file of built.files.filter((f) => f.endsWith('.css'))) {
      const css = await readFile(join(built.outdir, file), 'utf8')
      expect(css).not.toContain('data:font')
      expect(css).toContain('--primary')
      expect(css).toContain('shadow-hard')
    }
  })
  it('embeds every file into a `bun build --compile` binary', async () => {
    expect(await readFile(moduleFile, 'utf8')).toStartWith('// @ts-nocheck')
    const entry = join(work, 'gen', 'entry.ts')
    await Bun.write(
      entry,
      [
        `import { toAssetMap } from ${JSON.stringify(INDEX_MODULE)}`,
        "import { EMBEDDED_ASSETS } from './assets'",
        'const map = toAssetMap(EMBEDDED_ASSETS)',
        'const sizes = {}',
        'for (const [path, blob] of map ?? []) sizes[path] = (await blob.arrayBuffer()).byteLength',
        'console.log(JSON.stringify(sizes))',
      ].join('\n'),
    )
    const outfile = join(work, 'bin', 'probe')
    const compile = Bun.spawnSync([process.execPath, 'build', '--compile', entry, '--outfile', outfile], {
      stdout: 'pipe',
      stderr: 'pipe',
    })
    expect(compile.exitCode, compile.stderr.toString()).toBe(0)
    // Run with dist/ removed: the binary must not read the files from disk.
    await rm(built.outdir, { recursive: true, force: true })
    const run = Bun.spawnSync([outfile], { stdout: 'pipe', stderr: 'pipe' })
    expect(run.exitCode, run.stderr.toString()).toBe(0)
    const sizes = JSON.parse(run.stdout.toString()) as Record<string, number>
    expect(Object.keys(sizes).sort()).toEqual([...built.files].sort())
    expect(sizes['index.html']).toBeGreaterThan(100)
  }, 120_000)
})

describe('injectBootScript', () => {
  it('goes before the first script', () => {
    expect(injectBootScript('<head><script type="module" src="/a.js"></script></head>', '/b.js')).toBe(
      '<head><script src="/b.js"></script><script type="module" src="/a.js"></script></head>',
    )
  })
  it('falls back to the end of head', () => {
    expect(injectBootScript('<head><title>x</title></head>', '/b.js')).toBe(
      '<head><title>x</title><script src="/b.js"></script></head>',
    )
  })
})
