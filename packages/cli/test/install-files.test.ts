import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { lstat, mkdir, mkdtemp, readFile, readlink, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { replaceWithBackup, writeFileAtomic } from '../src/install/files'

let root: string
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'apc-files-'))
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('writeFileAtomic', () => {
  it('writes through a symlinked config (dotfile managers) and keeps the link', async () => {
    const dotfiles = join(root, 'dotfiles', 'codex')
    await mkdir(dotfiles, { recursive: true })
    const real = join(dotfiles, 'config.toml')
    await writeFile(real, 'model = "x"\n', { mode: 0o600 })
    const home = join(root, 'home', '.codex')
    await mkdir(home, { recursive: true })
    const link = join(home, 'config.toml')
    await symlink(real, link)
    const backup = await replaceWithBackup(link, 'model = "y"\n', Date.UTC(2026, 0, 2, 3, 4, 5))
    expect((await lstat(link)).isSymbolicLink()).toBe(true)
    expect(await readlink(link)).toBe(real)
    expect(await readFile(real, 'utf8')).toBe('model = "y"\n')
    expect((await stat(real)).mode & 0o777).toBe(0o600)
    expect(backup).toBe(`${link}.agent-peers-20260102T030405Z.bak`)
    expect(await readFile(backup ?? '', 'utf8')).toBe('model = "x"\n')
  })

  it('creates a new file with the given mode', async () => {
    const path = join(root, 'new', 'file.json')
    await writeFileAtomic(path, '{}', 0o640)
    expect(await readFile(path, 'utf8')).toBe('{}')
    expect((await stat(path)).mode & 0o777).toBe(0o640)
  })
})
