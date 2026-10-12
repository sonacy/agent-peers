import { describe, expect, it } from 'bun:test'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  collectVersions,
  runCheckVersions,
  versionMismatches,
} from '../../packages/cli/scripts/release/versions'
import { ADAPTER_VERSION } from '../../packages/cli/src/join/card'
import { CLI_VERSION } from '../../packages/cli/src/version'
import { cleanupDirs, REPO_ROOT, tempDir } from './helpers'

describe('one version everywhere', () => {
  it('every package, plugin manifest and ADAPTER_VERSION carry the CLI version', async () => {
    expect(ADAPTER_VERSION).toBe(CLI_VERSION)
    const entries = await collectVersions(REPO_ROOT)
    const sources = entries.map((entry) => entry.source)
    expect(sources).toContain('packages/cli/package.json')
    expect(sources).toContain('adapters/claude-code/.claude-plugin/plugin.json')
    expect(sources).toContain('adapters/codex/.codex-plugin/plugin.json')
    expect(sources).toContain('ADAPTER_VERSION')
    expect(versionMismatches(entries, CLI_VERSION)).toEqual([])
    expect(await runCheckVersions(REPO_ROOT)).toMatchObject({ code: 0 })
  })

  it('names every file that missed a bump', async () => {
    const root = await tempDir()
    try {
      const write = async (path: string, value: unknown) => {
        await mkdir(join(root, path, '..'), { recursive: true })
        await writeFile(join(root, path), JSON.stringify(value))
      }
      await write('packages/cli/package.json', { version: '0.2.0' })
      await write('packages/core/package.json', { version: '0.1.0' })
      await write('adapters/codex/.codex-plugin/plugin.json', { name: 'peers' })
      const entries = await collectVersions(root, '0.2.0')
      expect(versionMismatches(entries, '0.2.0')).toEqual([
        'adapters/codex/.codex-plugin/plugin.json: (none) (expected 0.2.0)',
        'packages/core/package.json: 0.1.0 (expected 0.2.0)',
      ])
      const result = await runCheckVersions(root, '0.3.0')
      expect(result.code).toBe(1)
      expect(result.message).toContain('packages/cli/package.json: 0.2.0 (expected 0.3.0)')
      expect(result.message).toContain(`ADAPTER_VERSION: ${ADAPTER_VERSION} (expected 0.3.0)`)
    } finally {
      await cleanupDirs()
    }
  })
})
