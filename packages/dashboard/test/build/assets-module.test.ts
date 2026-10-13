import { describe, expect, it } from 'bun:test'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, relative, sep } from 'node:path'
import {
  GENERATED_MODULE,
  listFiles,
  ORGANIZE_IMPORTS_OFF,
  quote,
  renderAssetsModule,
  renderStubModule,
} from '../../scripts/assets-module'

/** The module as staged in git (the index), or undefined outside a git checkout. */
function stagedModule(): string | undefined {
  const repo = Bun.spawnSync(['git', 'rev-parse', '--show-toplevel'], { cwd: dirname(GENERATED_MODULE) })
  if (repo.exitCode !== 0) return undefined
  const path = relative(repo.stdout.toString().trim(), GENERATED_MODULE).split(sep).join('/')
  const show = Bun.spawnSync(['git', 'show', `:${path}`], { cwd: dirname(GENERATED_MODULE) })
  return show.exitCode === 0 ? show.stdout.toString() : undefined
}

describe('generated assets module', () => {
  it('the stub embeds nothing', () => {
    const stub = renderStubModule()
    expect(stub).toContain(
      'export const EMBEDDED_ASSETS: ReadonlyArray<readonly [string, string]> | undefined = undefined',
    )
    expect(stub).not.toContain('import ')
  })
  it('the working-tree module is the stub or a build output whose files all exist', async () => {
    const source = await readFile(GENERATED_MODULE, 'utf8')
    if (source === renderStubModule()) return
    expect(source.startsWith('// @ts-nocheck')).toBe(true)
    const specs = [...source.matchAll(/^import f\d+ from '([^']+)'/gm)].map((m) => m[1] as string)
    const missing = specs.filter((spec) => !existsSync(join(dirname(GENERATED_MODULE), spec)))
    expect(missing).toEqual([])
  })
  // dist/ is gitignored: a committed build output breaks typecheck, tests and the build on a fresh
  // clone. `bun run clean` restores the stub before committing.
  it.skipIf(stagedModule() === undefined)('the version staged in git is the "not built" stub', () => {
    expect(stagedModule()).toBe(renderStubModule())
  })
  it('imports every file with a file attribute, sorted, relative to the module', () => {
    const source = renderAssetsModule(
      ['index.html', 'chunk-a.js', 'fonts/x.woff2'],
      '/pkg/dist',
      '/pkg/src/generated',
    )
    expect(source).toContain("import f0 from '../../dist/chunk-a.js' with { type: 'file' }")
    expect(source).toContain("import f1 from '../../dist/fonts/x.woff2' with { type: 'file' }")
    expect(source).toContain("  ['index.html', f2],")
  })
  it('turns off Biome import sorting, which would reorder hash-named chunks naturally', () => {
    const source = renderAssetsModule(['chunk-49gc.js', 'chunk-3797.js'], '/d', '/d')
    expect(source.split('\n')[1]).toBe(ORGANIZE_IMPORTS_OFF)
  })
  it('prefixes same-directory imports with ./', () => {
    expect(renderAssetsModule(['a.js'], '/x', '/x')).toContain("from './a.js'")
  })
  it('quotes safely', () => {
    expect(quote("it's")).toBe("'it\\'s'")
    expect(quote('a\\b')).toBe("'a\\\\b'")
  })
  it('lists files recursively as posix paths', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'peers-list-'))
    try {
      await mkdir(join(dir, 'nested'))
      await writeFile(join(dir, 'b.js'), '')
      await writeFile(join(dir, 'nested', 'a.css'), '')
      expect(await listFiles(dir)).toEqual(['b.js', 'nested/a.css'])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
