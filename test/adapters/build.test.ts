import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { runBuild } from '../../adapters/build'
import { assembleMarketplace, checkGenerated, generatedFiles, writeGenerated } from '../../adapters/build-lib'
import { validateClaudeCodePlugin } from '../../adapters/validate-claude'
import { ADAPTERS_DIR, copyAdapters, makeTempDir, removeDir } from './helpers'

let dir = ''
beforeEach(async () => {
  dir = await copyAdapters()
})
afterEach(async () => {
  await removeDir(dirname(dir))
})

describe('generated files', () => {
  it('are current in the committed tree', async () => {
    expect(await checkGenerated(ADAPTERS_DIR)).toEqual([])
  })

  it('reports stale, missing and unexpected files and rewrites them', async () => {
    await writeFile(join(dir, 'codex/skills/ask/SKILL.md'), 'edited by hand\n')
    await rm(join(dir, 'claude-desktop/server-instructions.md'))
    await mkdir(join(dir, 'claude-code/skills/old'), { recursive: true })
    expect(await checkGenerated(dir)).toEqual([
      'codex/skills/ask/SKILL.md: stale (run bun adapters/build.ts)',
      'claude-desktop/server-instructions.md: missing (run bun adapters/build.ts)',
      'claude-code/skills/old: no command generates this skill',
    ])
    expect([...(await writeGenerated(dir))].sort()).toEqual([
      'claude-desktop/server-instructions.md',
      'codex/skills/ask/SKILL.md',
    ])
    expect(await writeGenerated(dir)).toEqual([])
    await rm(join(dir, 'claude-code/skills/old'), { recursive: true })
    expect(await checkGenerated(dir)).toEqual([])
  })

  it('cover every command for both plugins plus the Desktop files', () => {
    const paths = generatedFiles().map((file) => file.path)
    expect(paths).toContain('claude-code/skills/ask/SKILL.md')
    expect(paths).toContain('codex/skills/ask/SKILL.md')
    expect(paths).toContain('claude-desktop/claude_desktop_config.template.json')
  })

  it('tolerates a tree without skills directories', async () => {
    const empty = await makeTempDir('empty')
    try {
      expect((await checkGenerated(empty)).every((issue) => issue.includes('missing'))).toBe(true)
    } finally {
      await removeDir(empty)
    }
  })
})

describe('marketplace assembly', () => {
  it('copies the Claude Code plugin under plugins/peers with the shim still executable', async () => {
    const market = join(dir, 'marketplace')
    await mkdir(join(market, 'plugins/peers'), { recursive: true })
    await writeFile(join(market, 'plugins/peers/stale.txt'), 'old')
    const target = await assembleMarketplace(dir, market)
    expect(target).toBe(join(market, 'plugins/peers'))
    expect(await validateClaudeCodePlugin(target)).toEqual([])
    expect((await stat(join(target, 'bin/agent-peers'))).mode & 0o111).not.toBe(0)
    await expect(readFile(join(target, 'stale.txt'))).rejects.toThrow()
  })

  it('fails when the plugin tree is missing', async () => {
    await rm(join(dir, 'claude-code'), { recursive: true })
    await expect(assembleMarketplace(dir, join(dir, 'marketplace'))).rejects.toThrow()
  })
})

describe('build script', () => {
  it('--check passes on a clean copy and fails on drift', async () => {
    expect(await runBuild(dir, ['--check'])).toEqual({ code: 0, lines: ['adapters: ok'] })
    await writeFile(join(dir, 'codex/skills/who/SKILL.md'), 'x')
    const failed = await runBuild(dir, ['--check'])
    expect(failed.code).toBe(1)
    expect(failed.lines.join('\n')).toContain('codex/skills/who/SKILL.md: stale')
  })

  it('regenerates and assembles, then reports remaining problems', async () => {
    await writeFile(join(dir, 'codex/skills/who/SKILL.md'), 'x')
    const built = await runBuild(dir, [])
    expect(built.code).toBe(0)
    expect(built.lines).toContain('wrote codex/skills/who/SKILL.md')
    await writeFile(join(dir, 'codex/mcp.json'), '{}')
    const broken = await runBuild(dir, [])
    expect(broken.code).toBe(1)
  })

  it('runs as a CLI against the committed tree', () => {
    const proc = Bun.spawnSync([process.execPath, join(ADAPTERS_DIR, 'build.ts'), '--check'], {
      stdout: 'pipe',
      stderr: 'pipe',
    })
    expect(proc.stdout.toString() + proc.stderr.toString()).toContain('adapters: ok')
    expect(proc.exitCode).toBe(0)
  })
})
