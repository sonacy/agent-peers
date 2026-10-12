import { describe, expect, it } from 'bun:test'
import { PeerTurnConfigSchema } from '../../src/config/schemas'
import { splitGlobList } from '../../src/gate/exposure'
import { checkPath, type PathContext } from '../../src/gate/paths'
import { evaluateGate, type GateInput } from '../../src/gate/policy'
import { parseShell } from '../../src/gate/shell-parse'

const policy = PeerTurnConfigSchema.parse({})
const CLEAN = ['/ws/src/a.ts', '/ws/README.md']
const SECRET = [...CLEAN, '/ws/certs/server.pem']

function gate(tool: string, input: unknown, patch: Partial<GateInput> = {}, files = CLEAN) {
  return evaluateGate({
    peerTurn: { ask_ids: ['ASK1'], room_ids: ['room1'] },
    tool,
    input,
    policy,
    workspaceRoot: '/ws',
    userHome: '/home/u',
    exists: (p) => files.some((f) => f === p || f.startsWith(`${p}/`)) || p === '/ws',
    listFiles: (dir) => files.filter((f) => f === dir || f.startsWith(`${dir}/`)),
    caseInsensitive: false,
    ...patch,
  })
}

const bash = (command: string, patch: Partial<GateInput> = {}, files = CLEAN) =>
  gate('Bash', { command }, patch, files)

describe('rg pattern flags in short clusters', () => {
  it('path-checks the operand after -ie / -if / -wie clusters', () => {
    for (const command of [
      'rg -ie . /etc/passwd',
      'rg -ie x /home/u/.ssh/id_rsa',
      'rg -if /etc/patterns /etc/passwd',
      'rg -wie . /etc/passwd',
      'rg --regexp=x /etc/passwd',
      'rg --regexp x /etc/passwd',
      'rg --file=/ws/README.md /etc/passwd',
    ])
      expect(bash(command).decision).toBe('deny')
    // -A takes the value "e": the next operand is the pattern, the one after a path.
    expect(bash('rg -Ae x /etc/passwd').decision).toBe('deny')
  })

  it('treats GNU long-option abbreviations as pattern flags', () => {
    const p = PeerTurnConfigSchema.parse({ allow_commands: ['grep'] })
    expect(bash('grep --reg x /etc/passwd', { policy: p }).decision).toBe('deny')
    expect(bash('grep --fil=/ws/README.md /etc/passwd', { policy: p }).decision).toBe('deny')
    expect(bash('grep -d recurse x src', { policy: p }).reason).toContain('-d')
  })

  it('checks the presumed pattern when it names an existing path', () => {
    expect(bash('rg /etc/passwd', { exists: (p) => p === '/etc/passwd' || p === '/ws' }).decision).toBe(
      'deny',
    )
    expect(bash('rg /api/v1 src').decision).toBe('allow')
    // Without an existence probe every presumed pattern is checked (strictest).
    const strict = evaluateGate({
      peerTurn: { ask_ids: ['A'], room_ids: ['r'] },
      tool: 'Bash',
      input: { command: 'rg /api/v1 src' },
      policy,
      workspaceRoot: '/ws',
      userHome: '/home/u',
      listFiles: () => [],
    })
    expect(strict.decision).toBe('deny')
  })
})

describe('rg flag allowlist', () => {
  it('refuses flags that run programs and unknown flags', () => {
    expect(bash('rg --hostname-bin=/ws/x --hyperlink-format=default foo').reason).toContain('--hostname-bin')
    expect(bash('rg --hyperlink-format=default foo').reason).toContain('--hyperlink-format')
    expect(bash('rg --some-future-flag foo').reason).toContain('flag allowlist')
    expect(bash('rg -K foo').reason).toContain('flag allowlist')
    expect(bash('rg -n -i --no-heading -C 2 foo src').decision).toBe('allow')
  })

  it('refuses wc --files0-from', () => {
    expect(bash('wc --files0-from=/etc/passwd').reason).toContain('--files0-from')
  })
})

describe('shell parsing edge cases', () => {
  it('refuses ~user, ~+, ~- and zsh =cmd expansions', () => {
    for (const command of [
      'cat ~gulei/.config/gh/hosts.yml',
      'cat ~root/.ssh/x',
      'cat ~+/x',
      'cat ~-/x',
      'cat =ls',
    ])
      expect(bash(command).reason).toMatch(/~|=/)
    expect(bash('cat ~').decision).toBe('deny')
    expect(bash("cat '~root'").decision).toBe('allow')
    expect(bash('git log HEAD~1').decision).toBe('allow')
  })

  it('refuses unusual whitespace without hanging', () => {
    for (const ws of [' ', '\v', '\f', ' ', '　']) {
      const parsed = parseShell(`ls${ws}-la`)
      expect(parsed.ok).toBe(false)
      expect(bash(`ls${ws}-la`).decision).toBe('deny')
    }
  })

  it('treats backslash-newline as a line continuation', () => {
    expect(bash('cat .e\\\nnv').reason).toContain('secret deny list')
    expect(bash('cat ".e\\\nnv"').reason).toContain('secret deny list')
    expect(parseShell('cat a \\\n b')).toEqual({ ok: true, segments: [['cat', 'a', 'b']] })
    expect(parseShell('cat "a\\b"')).toEqual({ ok: true, segments: [['cat', 'a\\b']] })
    expect(parseShell('cat "a\\"b"')).toEqual({ ok: true, segments: [['cat', 'a"b']] })
  })
})

describe('case-insensitive file systems', () => {
  const ci = { caseInsensitive: true }
  it('matches deny globs and the workspace root ignoring case', () => {
    expect(gate('Read', { file_path: '.ENV' }, ci).decision).toBe('deny')
    expect(bash('cat .ENV', ci).decision).toBe('deny')
    expect(gate('Read', { file_path: 'certs/Server.PEM' }, ci).decision).toBe('deny')
    expect(gate('Read', { file_path: 'keys/ID_RSA' }, ci).decision).toBe('deny')
    expect(gate('Read', { file_path: 'config/Credentials.json' }, ci).decision).toBe('deny')
    expect(gate('Read', { file_path: '/home/u/.SSH/config' }, ci).decision).toBe('deny')
    expect(gate('Read', { file_path: '/WS/src/a.ts' }, ci).decision).toBe('allow')
    expect(gate('Read', { file_path: '.ENV' }).decision).toBe('allow')
  })
})

describe('symlinks', () => {
  const realpath = (p: string) =>
    p.startsWith('/ws/link') ? p.replace('/ws/link', '/etc') : p === '/ws/config.txt' ? '/ws/.env' : p
  it('checks the resolved path for the root and both forms for deny globs', () => {
    expect(gate('Read', { file_path: 'link/secret.txt' }, { realpath }).reason).toContain('outside')
    expect(gate('Read', { file_path: 'config.txt' }, { realpath }).reason).toContain('secret deny list')
    const ctx: PathContext = { workspaceRoot: '/ws', userHome: '/h', denyGlobs: ['.env*'], realpath }
    expect(checkPath(ctx, 'src/a.ts')).toEqual({ ok: true, path: '/ws/src/a.ts' })
  })
})

describe('recursive searches and deny globs', () => {
  it('denies Grep and rg searches that would read a secret file', () => {
    expect(gate('Grep', { pattern: 'BEGIN' }, {}, SECRET).reason).toContain('certs/server.pem')
    expect(gate('Grep', { pattern: 'BEGIN', glob: '*.pem' }, {}, SECRET).decision).toBe('deny')
    expect(gate('Grep', { pattern: 'BEGIN', glob: '*.ts' }, {}, SECRET).decision).toBe('allow')
    expect(gate('Grep', { pattern: 'BEGIN', glob: '*.ts *.pem' }, {}, SECRET).decision).toBe('deny')
    expect(gate('Grep', { pattern: 'BEGIN', path: 'src' }, {}, SECRET).decision).toBe('allow')
    expect(bash('rg BEGIN', {}, SECRET).decision).toBe('deny')
    expect(bash('rg BEGIN .', {}, SECRET).decision).toBe('deny')
    expect(bash("rg -g '*.ts' BEGIN", {}, SECRET).decision).toBe('allow')
    expect(bash("rg -g '!*.pem' BEGIN", {}, SECRET).decision).toBe('allow')
    expect(bash("rg -g '!certs' BEGIN", {}, SECRET).decision).toBe('allow')
    expect(bash("rg --iglob '*.PEM' BEGIN", {}, SECRET).decision).toBe('deny')
    expect(bash('rg --type-list', {}, SECRET).decision).toBe('allow')
    expect(gate('Glob', { pattern: '**/*' }, {}, SECRET).decision).toBe('allow')
  })

  it('refuses recursive searches it cannot verify', () => {
    expect(gate('Grep', { pattern: 'x' }, { listFiles: undefined }).reason).toContain('cannot verify')
    expect(gate('Grep', { pattern: 'x' }, { listFiles: () => undefined }).reason).toContain('too large')
    expect(gate('Grep', { pattern: 'x' }, { listFiles: () => ['/elsewhere/a'] }).reason).toContain(
      'outside the workspace',
    )
  })

  it('handles git patches, pathspecs and rev:path forms', () => {
    expect(bash('git show :.env').reason).toContain('secret deny list')
    expect(bash('git show :0:.env').reason).toContain('secret deny list')
    expect(bash('git log -L1,9:.env').reason).toContain('secret deny list')
    expect(bash('git log -p', {}, SECRET).decision).toBe('deny')
    expect(bash('git diff', {}, SECRET).decision).toBe('deny')
    expect(bash('git show HEAD', {}, SECRET).decision).toBe('deny')
    expect(bash('git diff --stat', {}, SECRET).decision).toBe('allow')
    expect(bash('git show -s HEAD', {}, SECRET).decision).toBe('allow')
    expect(bash('git log --oneline', {}, SECRET).decision).toBe('allow')
    expect(bash('git show HEAD:src/a.ts', {}, SECRET).decision).toBe('allow')
    expect(bash('git diff -- src', {}, SECRET).decision).toBe('allow')
    expect(bash('git diff src', {}, SECRET).decision).toBe('allow')
    expect(bash('git diff -- certs', {}, SECRET).decision).toBe('deny')
  })

  it('requires the command working directory to be inside the workspace', () => {
    expect(bash('rg -i password', { cwd: '/home/u' }).reason).toContain('working directory')
    expect(bash('ls', { cwd: '/tmp' }).decision).toBe('deny')
    expect(bash('git log -p', { cwd: '/tmp' }).decision).toBe('deny')
    expect(bash('ls', { cwd: '/ws/src' }).decision).toBe('allow')
  })

  it('fails closed when a probe throws', () => {
    const listFiles = () => {
      throw new Error('boom')
    }
    expect(gate('Grep', { pattern: 'x' }, { listFiles }).reason).toContain('could not be checked')
  })

  it('splits glob lists outside braces', () => {
    expect(splitGlobList('*.{ts,tsx}')).toEqual(['*.{ts,tsx}'])
    expect(splitGlobList('*.ts, *.md  src/**')).toEqual(['*.ts', '*.md', 'src/**'])
    expect(splitGlobList('')).toEqual([])
  })
})
