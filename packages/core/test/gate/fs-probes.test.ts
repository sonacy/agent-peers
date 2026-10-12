import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PeerTurnConfigSchema } from '../../src/config/schemas'
import { cachedListFiles, fsExists, fsRealpath } from '../../src/gate/fs-probes'
import { evaluateGate } from '../../src/gate/policy'

let dir: string
let outside: string

beforeAll(async () => {
  dir = await realpath(await mkdtemp(join(tmpdir(), 'gate-fs-')))
  outside = await realpath(await mkdtemp(join(tmpdir(), 'gate-out-')))
  await mkdir(join(dir, 'ws', 'src'), { recursive: true })
  await writeFile(join(dir, 'ws', 'src', 'a.ts'), 'x')
  await writeFile(join(dir, 'ws', '.env'), 'SECRET=1')
  await writeFile(join(outside, 'notes.txt'), 'private')
  await symlink(outside, join(dir, 'ws', 'link'))
  await symlink(join(dir, 'ws', '.env'), join(dir, 'ws', 'config.txt'))
})

afterAll(async () => {
  await rm(dir, { recursive: true, force: true })
  await rm(outside, { recursive: true, force: true })
})

const git = (cwd: string, ...args: string[]) =>
  Bun.spawnSync(['git', '-C', cwd, ...args], { stdout: 'ignore', stderr: 'ignore' }).exitCode

describe('fsRealpath / fsExists', () => {
  it('resolves symlinks, including for paths that do not exist yet', () => {
    const ws = join(dir, 'ws')
    expect(fsRealpath(join(ws, 'link', 'notes.txt'))).toBe(join(outside, 'notes.txt'))
    expect(fsRealpath(join(ws, 'link', 'new', 'file.txt'))).toBe(join(outside, 'new', 'file.txt'))
    expect(fsRealpath(join(ws, 'config.txt'))).toBe(join(ws, '.env'))
    expect(fsRealpath('/definitely/not/here')).toBe('/definitely/not/here')
    expect(fsExists(join(ws, 'src', 'a.ts'))).toBe(true)
    expect(fsExists(join(ws, 'nope'))).toBe(false)
  })

  it('makes the production gate follow links out of the workspace and onto secrets', () => {
    const ws = join(dir, 'ws')
    const decide = (file_path: string) =>
      evaluateGate({
        peerTurn: { ask_ids: ['A'], room_ids: ['r'] },
        tool: 'Read',
        input: { file_path },
        policy: PeerTurnConfigSchema.parse({}),
        workspaceRoot: ws,
        userHome: '/nonexistent-home',
        realpath: fsRealpath,
        exists: fsExists,
        listFiles: cachedListFiles(),
      }).decision
    expect(decide(join(ws, 'link', 'notes.txt'))).toBe('deny')
    expect(decide(join(ws, 'config.txt'))).toBe('deny')
    expect(decide(join(ws, 'src', 'a.ts'))).toBe('allow')
  })
})

describe('cachedListFiles', () => {
  it('walks a plain directory (hidden files included) and caches the answer', async () => {
    let now = 0
    const list = cachedListFiles({ now: () => now, ttlMs: 100 })
    const plain = join(dir, 'plain')
    await mkdir(join(plain, '.git-not'), { recursive: true })
    await writeFile(join(plain, 'a.txt'), 'a')
    await writeFile(join(plain, '.hidden'), 'h')
    const first = list(plain, { repo: false }) ?? []
    expect([...first].sort()).toEqual([join(plain, '.hidden'), join(plain, 'a.txt')])
    await writeFile(join(plain, 'b.txt'), 'b')
    expect(list(plain, { repo: false })).toBe(first)
    now = 200
    expect(list(plain, { repo: false })?.length).toBe(3)
    expect(list(join(plain, 'a.txt'), { repo: false })).toEqual([join(plain, 'a.txt')])
    expect(list(join(plain, 'missing'), { repo: false })).toEqual([])
    expect(list(plain, { repo: true })).toBeUndefined()
  })

  it('reports overflow as undefined', async () => {
    const list = cachedListFiles({ maxFiles: 1 })
    expect(list(join(dir, 'plain'), { repo: false })).toBeUndefined()
  })

  it('lists tracked and untracked-but-not-ignored files in a git repository', async () => {
    const repo = join(dir, 'repo')
    await mkdir(join(repo, 'src'), { recursive: true })
    if (git(repo, 'init', '-q') !== 0) return
    await writeFile(join(repo, '.gitignore'), 'ignored.pem\n')
    await writeFile(join(repo, 'ignored.pem'), 'k')
    await writeFile(join(repo, 'src', 'a.ts'), 'a')
    await mkdir(join(repo, 'nested', 'inner'), { recursive: true })
    await writeFile(join(repo, 'nested', 'inner', 'b.ts'), 'b')
    const list = cachedListFiles()
    const files = [...(list(repo, { repo: false }) ?? [])].sort()
    expect(files).toEqual([
      join(repo, '.gitignore'),
      join(repo, 'nested', 'inner', 'b.ts'),
      join(repo, 'src', 'a.ts'),
    ])
    const whole = list(join(repo, 'src'), { repo: true }) ?? []
    expect(whole).toContain(join(repo, '.gitignore'))
    expect(list(join(repo, 'src'), { repo: false })).toEqual([join(repo, 'src', 'a.ts')])
  })
})
