import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { lstat, mkdir, readFile, readlink, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { EMBEDDED_ADAPTERS } from '../src/assets/adapters.generated'
import { installBinary, isCompiledBinary, removeBinaries, sourceBinary } from '../src/assets/binary'
import { collectAdapterFiles, renderEmbeddedModule, runEmbed } from '../src/assets/embed'
import {
  codexMarketplaceManifest,
  embeddedFile,
  materializePlugins,
  rewriteShim,
  SHIM_BIN_LINE,
  shQuote,
  syncTree,
} from '../src/assets/materialize'
import { type FakeMachine, fakeMachine } from './helpers/fake-agents'

const REPO = join(import.meta.dir, '..', '..', '..')
const ADAPTERS = join(REPO, 'adapters')
const CLI = join(REPO, 'packages', 'cli')

let m: FakeMachine
beforeEach(async () => {
  m = await fakeMachine()
})
afterEach(async () => {
  await m.cleanup()
})

describe('embedded adapters', () => {
  it('the committed module matches adapters/ (run bun scripts/embed-adapters.ts when this fails)', async () => {
    const expected = renderEmbeddedModule(await collectAdapterFiles(ADAPTERS))
    expect(await readFile(join(CLI, 'src', 'assets', 'adapters.generated.ts'), 'utf8')).toBe(expected)
    expect((await runEmbed(ADAPTERS, CLI, true)).code).toBe(0)
  })

  it('reports drift with --check and rewrites without it', async () => {
    const cli = join(m.root, 'cli')
    expect(await runEmbed(ADAPTERS, cli, true)).toEqual({
      code: 1,
      message: 'src/assets/adapters.generated.ts: stale (run bun scripts/embed-adapters.ts)',
    })
    expect((await runEmbed(ADAPTERS, cli, false)).message).toBe('wrote src/assets/adapters.generated.ts')
    expect((await runEmbed(ADAPTERS, cli, false)).message).toBe(
      'src/assets/adapters.generated.ts: up to date',
    )
  })

  it('carries both plugin trees, the marketplace and the Desktop files, shims executable', () => {
    const paths = EMBEDDED_ADAPTERS.map((file) => file.path)
    expect(paths).toContain('claude-code/hooks/hooks.json')
    expect(paths).toContain('codex/.codex-plugin/plugin.json')
    expect(paths).toContain('marketplace/.claude-plugin/marketplace.json')
    expect(paths).toContain('claude-desktop/server-instructions.md')
    expect(paths.some((path) => path.endsWith('.gitignore'))).toBe(false)
    const shims = EMBEDDED_ADAPTERS.filter((file) => file.path.endsWith('bin/agent-peers'))
    expect(shims.map((file) => file.mode)).toEqual([0o755, 0o755])
    expect(() => embeddedFile('nope')).toThrow('embedded adapter file missing: nope')
  })
})

describe('materialize', () => {
  it('pins the shim to the absolute binary and keeps AGENT_PEERS_BIN as override', () => {
    const shim = embeddedFile('claude-code/bin/agent-peers').toString('utf8')
    expect(shim).toContain(SHIM_BIN_LINE)
    const pinned = rewriteShim(shim, "/home/o'neil/.agent-peers/bin/agent-peers-0.1.0")
    expect(pinned).toContain(`installed_bin='/home/o'\\''neil/.agent-peers/bin/agent-peers-0.1.0'`)
    expect(pinned).toContain('bin="$' + '{AGENT_PEERS_BIN:-$installed_bin}"')
    expect(pinned).not.toContain(SHIM_BIN_LINE)
    expect(() => rewriteShim('#!/bin/sh\n', '/x')).toThrow('unexpected shim')
    expect(shQuote('a b')).toBe("'a b'")
  })

  it('writes both marketplaces and is idempotent', async () => {
    const binary = join(m.peersHome, 'bin', 'agent-peers-0.1.0')
    const layout = await materializePlugins(m.peersHome, '0.1.0', binary)
    const root = join(m.peersHome, 'plugins', '0.1.0')
    expect(layout.claudePlugin).toBe(join(root, 'marketplace', 'plugins', 'peers'))
    const claudeShim = join(layout.claudePlugin, 'bin', 'agent-peers')
    expect((await stat(claudeShim)).mode & 0o777).toBe(0o755)
    expect(await readFile(claudeShim, 'utf8')).toContain(`installed_bin='${binary}'`)
    expect(await readFile(join(layout.codexPlugin, 'bin', 'agent-peers'), 'utf8')).toContain(binary)
    const codexManifest = join(layout.codexMarketplace, '.agents', 'plugins', 'marketplace.json')
    expect(JSON.parse(await readFile(codexManifest, 'utf8'))).toEqual(JSON.parse(codexMarketplaceManifest()))
    expect(codexMarketplaceManifest()).toMatchSnapshot()
    const claudeManifest = join(layout.claudeMarketplace, '.claude-plugin', 'marketplace.json')
    expect(JSON.parse(await readFile(claudeManifest, 'utf8')).plugins[0].source).toBe('./plugins/peers')
    await writeFile(join(layout.claudePlugin, 'stale.txt'), 'old')
    await materializePlugins(m.peersHome, '0.1.0', binary)
    expect(await Bun.file(join(layout.claudePlugin, 'stale.txt')).exists()).toBe(false)
  })

  it('syncTree only rewrites what changed', async () => {
    const dest = join(m.root, 'tree')
    const files = [{ path: 'a/b.txt', mode: 0o644, content: Buffer.from('x') }]
    expect(await syncTree(dest, files)).toBe(1)
    expect(await syncTree(dest, files)).toBe(0)
  })
})

describe('installed binary', () => {
  it('copies the binary once and points current at it', async () => {
    const first = await installBinary(m.source, m.peersHome, '0.1.0')
    expect(first.changed).toBe(true)
    expect((await stat(first.versioned)).mode & 0o777).toBe(0o755)
    expect((await lstat(first.current)).isSymbolicLink()).toBe(true)
    expect(await readlink(first.current)).toBe('agent-peers-0.1.0')
    expect((await installBinary(m.source, m.peersHome, '0.1.0')).changed).toBe(false)
    const next = await installBinary(m.source, m.peersHome, '0.2.0')
    expect(next.changed).toBe(true)
    expect(await readlink(next.current)).toBe('agent-peers-0.2.0')
    await removeBinaries(m.peersHome)
    expect(await Bun.file(next.versioned).exists()).toBe(false)
  })

  it('knows where the binary to install comes from', () => {
    expect(isCompiledBinary('/$bunfs/root/agent-peers')).toBe(true)
    expect(isCompiledBinary('/repo/packages/cli/src/bin.ts')).toBe(false)
    expect(sourceBinary({ AGENT_PEERS_BINARY: '/dev/bin' }, false)).toBe('/dev/bin')
    expect(sourceBinary({}, false)).toBeUndefined()
    expect(sourceBinary({}, true)).toBe(process.execPath)
  })

  it('replaces a stale binary of the same version', async () => {
    await mkdir(join(m.peersHome, 'bin'), { recursive: true })
    await writeFile(join(m.peersHome, 'bin', 'agent-peers-0.1.0'), 'old')
    expect((await installBinary(m.source, m.peersHome, '0.1.0')).changed).toBe(true)
    expect(await readFile(join(m.peersHome, 'bin', 'agent-peers-0.1.0'), 'utf8')).toContain('selftest')
  })
})
