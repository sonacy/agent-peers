import { describe, expect, it } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  GENERATED_MODULE,
  listFiles,
  quote,
  renderAssetsModule,
  renderStubModule,
} from '../../scripts/assets-module'

describe('generated assets module', () => {
  it('the stub embeds nothing', () => {
    const stub = renderStubModule()
    expect(stub).toContain(
      'export const EMBEDDED_ASSETS: ReadonlyArray<readonly [string, string]> | undefined = undefined',
    )
    expect(stub).not.toContain('import ')
  })
  it('the checked-in module is the stub or a build output', async () => {
    const source = await readFile(GENERATED_MODULE, 'utf8')
    const isStub = source === renderStubModule()
    expect(isStub || source.startsWith('// @ts-nocheck')).toBe(true)
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
