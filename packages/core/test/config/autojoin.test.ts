import { describe, expect, it } from 'bun:test'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  defaultAutojoinScope,
  isInsideGitRepo,
  matchAutojoin,
  matchesAutojoin,
  removeAutojoin,
  upsertAutojoin,
} from '../../src/config/autojoin'
import type { AutojoinEntry } from '../../src/config/schemas'

const entry = (patch: Partial<AutojoinEntry> = {}): AutojoinEntry => ({
  hub: 'https://hub.example.com',
  room_id: 'r1',
  handle: 'api',
  agent: 'claude-code',
  workspace: '/w',
  scope: 'workspace',
  ...patch,
})

describe('autojoin helpers', () => {
  it('upserts by (hub, room, workspace) without mutating', () => {
    const start = [entry()]
    const next = upsertAutojoin(start, entry({ handle: 'api2', hub: 'wss://hub.example.com' }))
    expect(start[0]?.handle).toBe('api')
    expect(next).toHaveLength(1)
    expect(next[0]?.handle).toBe('api2')
    expect(upsertAutojoin(next, entry({ workspace: '/other' }))).toHaveLength(2)
  })

  it('removes a room, or one workspace of it', () => {
    const list = [entry(), entry({ workspace: '/x' }), entry({ room_id: 'r2' })]
    expect(removeAutojoin(list, { hub: 'https://hub.example.com', room_id: 'r1' })).toHaveLength(1)
    expect(
      removeAutojoin(list, { hub: 'https://hub.example.com', room_id: 'r1', workspace: '/x' }),
    ).toHaveLength(2)
  })

  it('matches by scope and agent', () => {
    expect(matchesAutojoin(entry(), { workspace: '/w' })).toBe(true)
    expect(matchesAutojoin(entry(), { workspace: '/w/sub' })).toBe(false)
    expect(matchesAutojoin(entry(), { workspace: '/w', agent: 'codex' })).toBe(false)
    expect(matchesAutojoin(entry({ agent: 'other' }), { workspace: '/w', agent: 'codex' })).toBe(true)
    expect(matchesAutojoin(entry({ scope: 'session', local_key: 'k' }), { local_key: 'k' })).toBe(true)
    expect(matchesAutojoin(entry({ scope: 'session', local_key: 'k' }), { workspace: '/w' })).toBe(false)
    expect(matchesAutojoin(entry({ scope: 'none' }), { workspace: '/w', local_key: 'k' })).toBe(false)
    expect(matchAutojoin([entry(), entry({ scope: 'none' })], { workspace: '/w' })).toHaveLength(1)
  })

  it('defaults to session scope at home, at / and outside git', async () => {
    const root = await mkdtemp(join(tmpdir(), 'peers-aj-'))
    try {
      const repo = join(root, 'repo')
      await mkdir(join(repo, '.git'), { recursive: true })
      await mkdir(join(repo, 'pkg'))
      await mkdir(join(root, 'plain'))
      expect(await isInsideGitRepo(join(repo, 'pkg'))).toBe(true)
      expect(await defaultAutojoinScope(join(repo, 'pkg'), root)).toBe('workspace')
      expect(await defaultAutojoinScope(join(root, 'plain'), '/nonexistent-home')).toBe(
        (await isInsideGitRepo(join(root, 'plain'))) ? 'workspace' : 'session',
      )
      expect(await defaultAutojoinScope(root, root)).toBe('session')
      expect(await defaultAutojoinScope('/', root)).toBe('session')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
