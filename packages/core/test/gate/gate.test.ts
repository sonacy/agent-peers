import { describe, expect, it } from 'bun:test'
import { PeerTurnConfigSchema } from '../../src/config/schemas'
import { checkPath, globBase, type PathContext } from '../../src/gate/paths'
import {
  evaluateGate,
  evaluatePermission,
  type GateInput,
  type PeerTurnView,
  patchPaths,
} from '../../src/gate/policy'
import { canonicalToolName, classifyTool } from '../../src/gate/tools'

const policy = PeerTurnConfigSchema.parse({})
const turn: PeerTurnView = { ask_ids: ['ASK1'], room_ids: ['room1'] }

/** A tiny fake file system: what exists, and what a recursive search of a directory lists. */
const FILES = ['/ws/src/a.ts', '/ws/README.md', '/ws/log.txt', '/ws/pkg/a.ts', '/ws/a b.txt']
const exists = (path: string) =>
  FILES.includes(path) || FILES.some((f) => f.startsWith(`${path}/`)) || path === '/ws'
const listFiles = (dir: string) => FILES.filter((f) => f === dir || f.startsWith(`${dir}/`))

function gate(tool: string, input: unknown, patch: Partial<GateInput> = {}) {
  return evaluateGate({
    peerTurn: turn,
    tool,
    input,
    policy,
    workspaceRoot: '/ws',
    userHome: '/home/u',
    exists,
    listFiles,
    caseInsensitive: false,
    ...patch,
  })
}

const decision = (tool: string, input: unknown, patch: Partial<GateInput> = {}) =>
  gate(tool, input, patch).decision

describe('classifyTool', () => {
  it('maps surface names to canonical tools', () => {
    expect(classifyTool('Read')).toEqual({ kind: 'read', name: 'Read' })
    expect(classifyTool('read_file')).toEqual({ kind: 'read', name: 'Read' })
    expect(classifyTool('Bash')).toEqual({ kind: 'shell', name: 'Bash' })
    expect(classifyTool('shell')).toEqual({ kind: 'shell', name: 'Bash' })
    expect(classifyTool('exec_command')).toEqual({ kind: 'shell', name: 'Bash' })
    expect(classifyTool('Shell')).toEqual({ kind: 'shell', name: 'Bash' })
    expect(classifyTool('apply_patch')).toEqual({ kind: 'write', name: 'apply_patch' })
    expect(classifyTool('Edit')).toEqual({ kind: 'write', name: 'Edit' })
    expect(classifyTool('WebFetch')).toEqual({ kind: 'other', name: 'WebFetch' })
  })

  it('recognizes peers tools from every surface', () => {
    for (const name of [
      'mcp__plugin_peers_peers__peers_reply',
      'mcp__peers__peers_reply',
      'mcp__agent-peers-desktop__peers_reply',
      'peers.peers_reply',
      'peers/reply',
      'peers_reply',
    ])
      expect(classifyTool(name)).toEqual({ kind: 'peers', name: 'peers_reply' })
    expect(classifyTool('mcp__github__create_issue')).toEqual({
      kind: 'mcp',
      name: 'mcp__github__create_issue',
      server: 'github',
    })
    expect(classifyTool('mcp__evilpeers__peers_reply').kind).toBe('mcp')
    expect(classifyTool('mcp__broken').kind).toBe('other')
    expect(canonicalToolName(' Grep ')).toBe('Grep')
  })
})

describe('evaluateGate', () => {
  it('never objects outside a peer turn', () => {
    expect(gate('Write', { file_path: '/etc/passwd' }, { peerTurn: null })).toEqual({
      decision: 'allow',
      reason: 'not in a peer turn',
    })
  })

  it('allows read-only tools inside the workspace', () => {
    expect(decision('Read', { file_path: '/ws/src/a.ts' })).toBe('allow')
    expect(decision('Read', { file_path: 'src/a.ts' })).toBe('allow')
    expect(decision('Grep', { pattern: 'x' })).toBe('allow')
    expect(decision('Glob', { pattern: 'src/**/*.ts' })).toBe('allow')
    expect(decision('read_file', { path: 'README.md' })).toBe('allow')
  })

  it('denies paths outside the workspace and secrets', () => {
    expect(gate('Read', { file_path: '/etc/passwd' }).reason).toContain('outside the workspace root')
    expect(gate('Read', { file_path: '../other/x' }).reason).toContain('outside the workspace root')
    expect(gate('Read', { file_path: '/ws/.env.local' }).reason).toContain('secret deny list (.env*)')
    expect(decision('Read', { file_path: '/ws/certs/server.pem' })).toBe('deny')
    expect(decision('Read', { file_path: '/ws/keys/id_ed25519' })).toBe('deny')
    expect(decision('Read', { file_path: '/ws/.npmrc' })).toBe('deny')
    expect(decision('Read', { file_path: '/ws/config/credentials.json' })).toBe('deny')
    expect(gate('Read', { file_path: '~/.ssh/config' }).reason).toContain('~/.ssh')
    expect(decision('Glob', { pattern: '/etc/*' })).toBe('deny')
    expect(decision('Grep', { pattern: 'x', path: '/home/u/.aws' })).toBe('deny')
  })

  it('follows symlinks through the injected realpath', () => {
    const realpath = (p: string) => (p === '/ws/link' ? '/etc/shadow' : p)
    expect(decision('Read', { file_path: 'link' }, { realpath })).toBe('deny')
  })

  it('respects the hook cwd', () => {
    expect(decision('Read', { file_path: 'a.ts' }, { cwd: '/ws/pkg' })).toBe('allow')
    expect(decision('Read', { file_path: '../../x' }, { cwd: '/ws/pkg' })).toBe('deny')
  })

  it('gates peers tools', () => {
    expect(decision('mcp__plugin_peers_peers__peers_reply', { ask_id: 'ASK1', text: 'hi' })).toBe('allow')
    expect(decision('mcp__peers__peers_progress', { ask_id: 'ASK1', text: 'working' })).toBe('allow')
    expect(gate('mcp__peers__peers_reply', { ask_id: 'OTHER' }).reason).toContain('only for the ask')
    expect(decision('peers_reply', {})).toBe('deny')
    for (const tool of [
      'peers_send',
      'peers_ask',
      'peers_join',
      'peers_leave',
      'peers_create',
      'peers_invite',
      'peers_knock',
    ])
      expect(gate(`mcp__peers__${tool}`, {}).reason).toContain(`${tool} is disabled during a peer turn`)
    expect(gate('peers_inbox', {}).reason).toContain('peers_inbox is not allowed')
  })

  it('denies writes, other MCP tools and unknown tools by default', () => {
    expect(gate('Edit', { file_path: '/ws/a.ts' }).reason).toContain('read-only')
    expect(decision('apply_patch', { input: '*** Update File: a.ts' })).toBe('deny')
    expect(decision('mcp__github__create_issue', {})).toBe('deny')
    expect(decision('WebFetch', { url: 'https://x' })).toBe('deny')
    expect(gate('Task', {}).reason).toMatch(/^agent-peers: /)
  })

  // Live regression: Claude Code defers MCP tools, so a peer turn that cannot call ToolSearch cannot
  // load peers_reply at all.
  it('allows ToolSearch, which only loads deferred tool definitions', () => {
    expect(classifyTool('ToolSearch')).toEqual({ kind: 'meta', name: 'ToolSearch' })
    expect(decision('ToolSearch', { query: 'select:mcp__plugin_peers_peers__peers_reply' })).toBe('allow')
  })

  it('allows opted-in writes per room, with path checks', () => {
    const p = PeerTurnConfigSchema.parse({ write_allowlist: { room1: ['Edit', 'apply_patch', 'TodoWrite'] } })
    expect(decision('Edit', { file_path: '/ws/a.ts' }, { policy: p })).toBe('allow')
    expect(decision('Edit', { file_path: '/ws/.env' }, { policy: p })).toBe('deny')
    expect(decision('Edit', {}, { policy: p })).toBe('deny')
    expect(decision('TodoWrite', {}, { policy: p })).toBe('allow')
    expect(
      decision(
        'apply_patch',
        { input: '*** Begin Patch\n*** Add File: src/n.ts\n+x\n*** End Patch' },
        { policy: p },
      ),
    ).toBe('allow')
    expect(
      decision('apply_patch', { command: ['apply_patch', '*** Update File: /etc/hosts\n'] }, { policy: p }),
    ).toBe('deny')
    const twoRooms = { ask_ids: ['ASK1'], room_ids: ['room1', 'room2'] }
    expect(decision('Edit', { file_path: '/ws/a.ts' }, { policy: p, peerTurn: twoRooms })).toBe('deny')
  })

  it('allows extra tools from allow_tools', () => {
    const p = PeerTurnConfigSchema.parse({ allow_tools: ['Read', 'WebSearch'] })
    expect(decision('WebSearch', { query: 'x' }, { policy: p })).toBe('allow')
    expect(decision('Grep', { pattern: 'x' }, { policy: p })).toBe('deny')
  })
})

describe('shell commands in peer turns', () => {
  const bash = (command: unknown, extra: Record<string, unknown> = {}) => gate('Bash', { command, ...extra })
  const ok = (command: unknown) => expect(bash(command).decision).toBe('allow')
  const no = (command: unknown, why?: string | RegExp) => {
    const result = bash(command)
    expect(result.decision).toBe('deny')
    if (why) expect(result.reason).toMatch(why)
  }

  it('allows allowlisted read-only commands', () => {
    ok('git status')
    ok('git log --oneline -n 5')
    ok('git --no-pager diff HEAD~1 -- src/a.ts')
    ok('git show HEAD:src/a.ts')
    ok('git log -Scache -p')
    ok('rg -n "retry policy" src')
    ok("rg -tts -g '*.ts' foo")
    ok('rg -e foo -e bar')
    ok('ls -la src')
    ok('cat README.md | head -n 20')
    ok('git status && git diff')
    ok('pwd')
    ok('tail -n 5 log.txt')
    ok(['bash', '-lc', 'git status'])
    ok(['git', 'log'])
    ok('cat "a\\"b.txt"')
    ok('git status\n\ngit diff\n')
    ok('cat a\\ b.txt')
  })

  it('denies commands off the allowlist', () => {
    no('rm -rf /', /not on the peer-turn command allowlist/)
    no('git push')
    no('git commit -m x')
    no('cat a.ts; rm a.ts')
    no('cat a | sh')
    no('/usr/bin/git status')
    no(['python3', '-c', 'print(1)'])
  })

  it('denies shell features that hide what runs', () => {
    no('cat $HOME/.ssh/id_rsa', /variable expansion/)
    no('cat "$HOME/x"', /variable expansion/)
    no('ls `pwd`', /command substitution/)
    no('git log > out.txt', /redirection/)
    no('cat < /etc/passwd', /redirection/)
    no('(git status)', /subshells/)
    no('git status &', /background/)
    no('cat .e*', /unquoted globs/)
    no('cat .{env,x}', /brace expansion/)
    no('GIT_EXTERNAL_DIFF=x git diff', /environment assignments/)
    no('git status && ', /empty command/)
    no('', /empty command/)
    no("cat 'unterminated", /unterminated single/)
    no('cat "unterminated', /unterminated double/)
    no('cat \\', /dangling backslash/)
    no('# comment', /comments/)
    no(42, /missing or malformed/)
    no(['bash', 7], /missing or malformed/)
  })

  it('denies dangerous flags', () => {
    no('rg --pre cat foo', /--pre/)
    no('rg --hidden foo', /--hidden/)
    no('rg -uu foo', /-u/)
    no('rg --no-ignore-vcs foo', /--no-ignore/)
    no('git diff --no-index /etc/passwd a', /--no-index/)
    no('git log --output=x', /--output/)
    no('tail -f log.txt', /-f/)
  })

  it('checks every path argument', () => {
    no('cat /etc/passwd', /outside the workspace/)
    no('cat ~/.ssh/id_rsa', /~\/.ssh/)
    no('cat .env', /secret deny list/)
    no('git show HEAD:.env', /secret deny list/)
    no('rg foo /etc', /outside the workspace/)
    no('rg -f /etc/patterns foo', /outside the workspace/)
    no('rg --file=/etc/patterns foo', /outside the workspace/)
    no('rg -f/etc/patterns', /outside the workspace/)
    no('git log -O/etc/order', /outside the workspace/)
    ok('rg /api/v1 src')
    ok("cat 'a b.txt'")
    ok('cat -- -weird')
  })

  it('honors workdir and rejects one outside the workspace', () => {
    expect(bash('cat a.ts', { workdir: '/ws/pkg' }).decision).toBe('allow')
    expect(bash('cat ../../x', { workdir: '/ws/pkg' }).decision).toBe('deny')
    expect(bash('ls', { workdir: '/tmp' }).decision).toBe('deny')
  })

  it('uses the configured command allowlist', () => {
    const p = PeerTurnConfigSchema.parse({ allow_commands: ['grep', 'git log'] })
    expect(gate('Bash', { command: 'grep -n foo a.txt' }, { policy: p }).decision).toBe('allow')
    expect(gate('Bash', { command: 'grep -r foo .' }, { policy: p }).decision).toBe('deny')
    expect(gate('Bash', { command: 'git status' }, { policy: p }).decision).toBe('deny')
  })
})

describe('paths', () => {
  const ctx: PathContext = {
    workspaceRoot: '/ws',
    userHome: '/home/u',
    denyGlobs: ['~/.config/gh', '/opt/sec*', 'conf/*.secret'],
  }

  it('matches prefix, glob-prefix and nested patterns', () => {
    expect(checkPath(ctx, '~/.config/gh/hosts.yml').ok).toBe(false)
    expect(checkPath(ctx, '/opt/secrets/x').ok).toBe(false)
    expect(checkPath(ctx, '/ws/conf/a.secret').ok).toBe(false)
    expect(checkPath(ctx, '/ws/conf/a.txt').ok).toBe(true)
    expect(checkPath(ctx, 'a\u0000b').ok).toBe(false)
  })

  it('computes glob bases', () => {
    expect(globBase('src/**/*.ts')).toBe('src')
    expect(globBase('*.ts')).toBe('.')
    expect(globBase('/etc/*')).toBe('/etc')
    expect(globBase('/*')).toBe('/')
    expect(globBase('a/b')).toBe('a/b')
  })

  it('extracts apply_patch paths', () => {
    expect(patchPaths('*** Add File: a\n*** Update File: b\n*** Move to: c\n*** Delete File: d')).toEqual([
      'a',
      'b',
      'c',
      'd',
    ])
  })
})

describe('evaluatePermission', () => {
  it('pre-approves peers_reply/progress only', () => {
    expect(evaluatePermission({ peerTurn: null, tool: 'mcp__peers__peers_reply' }).allow).toBeUndefined()
    expect(
      evaluatePermission({
        peerTurn: null,
        tool: 'mcp__peers__peers_reply',
        input: { ask_id: 'ASK9' },
        gatedAskIds: ['ASK9'],
      }).allow,
    ).toBe(true)
    expect(
      evaluatePermission({
        peerTurn: null,
        tool: 'peers_reply',
        input: { ask_id: 'ASK8' },
        gatedAskIds: ['ASK9'],
      }).allow,
    ).toBeUndefined()
    expect(
      evaluatePermission({ peerTurn: turn, tool: 'peers_progress', input: { ask_id: 'ASK1' } }).allow,
    ).toBe(true)
    expect(
      evaluatePermission({ peerTurn: turn, tool: 'peers_reply', input: { ask_id: 'X' } }).allow,
    ).toBeUndefined()
    expect(evaluatePermission({ peerTurn: null, tool: 'peers_join' }).allow).toBeUndefined()
    expect(evaluatePermission({ peerTurn: null, tool: 'peers_create' }).allow).toBeUndefined()
    expect(evaluatePermission({ peerTurn: null, tool: 'Bash' }).allow).toBeUndefined()
  })
})
