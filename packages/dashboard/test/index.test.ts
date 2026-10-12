import { describe, expect, it } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { dashboardAssets, PACKAGE_NAME, toAssetMap } from '../src/index'

describe('@agent-peers/dashboard entry', () => {
  it('exports its package name', () => {
    expect(PACKAGE_NAME).toBe('@agent-peers/dashboard')
  })
  it('maps embedded file paths to blobs', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'peers-dash-'))
    try {
      await writeFile(join(dir, 'index.html'), '<!doctype html>')
      const map = toAssetMap([['index.html', join(dir, 'index.html')]])
      expect(map?.size).toBe(1)
      expect(await map?.get('index.html')?.text()).toBe('<!doctype html>')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
  it('returns undefined when nothing is embedded', () => {
    expect(toAssetMap(undefined)).toBeUndefined()
    expect(toAssetMap([])).toBeUndefined()
  })
  it('dashboardAssets() is undefined unbuilt, or holds index.html when built', () => {
    const assets = dashboardAssets()
    if (assets !== undefined) expect(assets.has('index.html')).toBe(true)
    else expect(assets).toBeUndefined()
  })
})
