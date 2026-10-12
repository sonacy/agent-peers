import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { chmod, mkdir, writeFile } from 'node:fs/promises'
import { join as joinPath } from 'node:path'
import type { ProcessTree } from '@agent-peers/core'
import { PeersError } from '@agent-peers/protocol'
import type { AgentDetection, FoundBinary } from '../../src/agents/types'
import { codexAncestorBinary, withRunningBinary, withRunningCodex } from '../../src/join/detect'
import { isSandboxFailure } from '../../src/join/errors'
import { failureCode, NetworkError } from '../../src/join/hub-http'
import { runJoin } from '../../src/join/run'
import { installCommand, sandboxCommand, sandboxReport, trustedInstallOrigin } from '../../src/join/sandbox'
import { CLI_VERSION } from '../../src/version'
import { FAKE_CODEX, installFakeClaude } from '../helpers/fake-agents'
import { type JoinWorld, output, startJoinWorld } from '../helpers/join-world'

const CLAUDE: Record<string, string> = { CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: 'cc-bob' }
const CODEX: Record<string, string> = { CODEX_THREAD_ID: 'thread-9' }

describe('agent-peers join: sandboxed network', () => {
  let w: JoinWorld
  beforeEach(async () => {
    w = await startJoinWorld()
    await installFakeClaude(w.m)
  })
  afterEach(async () => {
    await w.stop()
  })

  async function join(url: string, options: Parameters<typeof runJoin>[1], env = CLAUDE, extra = {}) {
    const io = w.io(env)
    const code = await runJoin(url, options, io, w.deps(extra))
    return { code, ...output(io) }
  }

  const code = () => w.inviteUrl.split('/').at(-1) ?? ''

  it('real Bun fetch to an unresolvable host inside an agent exits 3 (DNS says ENOTFOUND)', async () => {
    const url = `https://agent-peers-test.invalid/j/${code()}`
    const result = await join(url, { here: true, handle: 'api' })
    expect(result.code).toBe(3)
    expect(result.err).toContain("blocked by your agent's sandbox")
    expect(result.err).toMatch(/DNS lookup: E[A-Z_]+/)
    // Preview-time stop: the terminal command keeps the flags, the session key and the workspace.
    expect(result.err).toContain(`join ${url} --here --handle api`)
    expect(result.err).toContain(`join ${url} -a claude-code --session-key cc-bob --handle api`)
    expect(result.err).toMatch(/cd \S+\/src\/payments-api && curl/)
    expect(result.err).toContain(`curl -fsSL https://agent-peers-test.invalid/install.sh`)
  })

  it('under CODEX_SANDBOX any network failure at preview is the sandbox (exit 3)', async () => {
    const refused = async () => {
      throw Object.assign(new Error('Unable to connect'), { code: 'ConnectionRefused' })
    }
    const env = { ...CODEX, CODEX_SANDBOX: 'seatbelt' }
    const options = {
      here: true,
      handle: 'api',
      name: 'bob',
      summary: 'retry work',
      remember: 'workspace' as const,
    }
    const result = await join(w.inviteUrl, options, env, { fetch: refused })
    expect(result.code).toBe(3)
    expect(result.err).toContain(
      "-a codex --session-key thread-9 --handle api --name bob --summary 'retry work' --remember workspace",
    )
    expect(result.err).toMatch(/cd \S+\/src\/payments-api && curl/)
  })

  it('outside a sandbox a refused connection stays "cannot reach" (exit 4)', async () => {
    const refused = async () => {
      throw Object.assign(new Error('Unable to connect'), { code: 'ConnectionRefused' })
    }
    const result = await join(w.inviteUrl, { here: true }, CLAUDE, { fetch: refused })
    expect(result.code).toBe(4)
    expect(result.err).toContain('cannot reach 127.0.0.1')
  })

  it('rejects invite links whose host could inject shell (exit 2, nothing printed to run)', async () => {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: a shell payload, not a template
    for (const host of ['a$(id).com', 'a;touch${IFS}x;b.com', 'a`id`.com']) {
      const result = await join(`https://${host}/j/${code()}`, { here: true })
      expect(result.code).toBe(2)
      expect(result.err).toContain('is not an invite link')
      expect(result.err).not.toContain('curl')
    }
  })
})

describe('sandbox commands', () => {
  const source = {
    invite: { url: 'https://hub.example.com/j/CODE', origin: 'https://hub.example.com' },
    agent: { ids: ['codex'] },
    workspace: "/w/it's here",
  }

  it('quotes the hub URL and cds into the workspace for the terminal', () => {
    const report = sandboxReport('r', sandboxCommand(source, { here: true, insecure: true }, 'k-1'))
    expect(report.code).toBe(3)
    expect(report.lines[3]).toBe(
      '  curl -fsSL https://hub.example.com/install.sh | sh -s -- join https://hub.example.com/j/CODE --here --insecure',
    )
    expect(report.lines[5]).toBe(
      `  cd '/w/it'\\''s here' && curl -fsSL https://hub.example.com/install.sh | sh -s -- join https://hub.example.com/j/CODE -a codex --session-key k-1 --insecure`,
    )
    expect(installCommand('https://we$(ird)', ['join'])).toBe(
      "curl -fsSL 'https://we$(ird)/install.sh' | sh -s -- join",
    )
  })

  it('never pipes a plain-http (non-loopback) hub installer into sh', () => {
    const lan = {
      ...source,
      invite: { url: 'http://192.168.1.5:7337/j/CODE', origin: 'http://192.168.1.5:7337' },
    }
    const report = sandboxReport('r', { ...sandboxCommand(lan, { sessionKey: 's' }, ''), version: '1.2.3' })
    const pinned =
      "curl --proto '=https' --tlsv1.2 -fsSL https://github.com/sonacy/agent-peers/releases/download/v1.2.3/install.sh | sh -s -- --version 1.2.3"
    expect(report.lines[3]).toBe(`  ${pinned} join http://192.168.1.5:7337/j/CODE -a codex --session-key s`)
    expect(report.lines[5]).toContain(`${pinned} join http://192.168.1.5:7337/j/CODE -a codex`)
    expect(report.lines[5]).not.toContain('--session-key')
    expect(report.lines.at(-1)).toContain('plain http://')
    expect(installCommand('http://hub.example.com', ['join'])).toContain(
      `download/v${CLI_VERSION}/install.sh`,
    )
    expect(trustedInstallOrigin('http://127.0.0.1:7337')).toBe(true)
    expect(trustedInstallOrigin('http://localhost:7337')).toBe(true)
    expect(trustedInstallOrigin('http://100.64.0.1')).toBe(false)
    expect(trustedInstallOrigin('not a url')).toBe(false)
  })
})

describe('sandbox-shaped failures', () => {
  it('treats any network or errno failure as the sandbox when CODEX_SANDBOX is set', () => {
    expect(isSandboxFailure(new NetworkError('x', 'ConnectionRefused'))).toBe(false)
    expect(isSandboxFailure(new NetworkError('x', 'ConnectionRefused'), true)).toBe(true)
    expect(isSandboxFailure(new NetworkError('x', undefined), true)).toBe(true)
    expect(isSandboxFailure(new NetworkError('x', 'EAI_AGAIN'))).toBe(true)
    expect(isSandboxFailure(Object.assign(new Error('x'), { code: 'ECONNRESET' }), true)).toBe(true)
    expect(isSandboxFailure(Object.assign(new Error('x'), { code: 'ECONNRESET' }))).toBe(false)
    expect(isSandboxFailure(new PeersError('internal', 'x'), true)).toBe(false)
  })

  it('looks the host up when the fetch error has no errno', async () => {
    const refused = { code: 'ConnectionRefused' }
    const nx = async () => {
      throw Object.assign(new Error('nx'), { code: 'ENOTFOUND' })
    }
    const ok = async () => ({ address: '10.0.0.1' })
    expect(await failureCode(refused, 'hub.example.com', nx)).toBe('ENOTFOUND')
    expect(await failureCode(refused, 'hub.example.com', ok)).toBe('ConnectionRefused')
    expect(await failureCode(refused, '127.0.0.1', nx)).toBe('ConnectionRefused')
    expect(await failureCode(refused, '[::1]', nx)).toBe('ConnectionRefused')
    expect(await failureCode({ code: 'EPERM' }, 'hub.example.com', ok)).toBe('EPERM')
    const odd = async () => {
      throw new Error('no code')
    }
    expect(await failureCode(refused, 'hub.example.com', odd)).toBe('ConnectionRefused')
  })
})

describe('the running Codex binary', () => {
  const linuxTree: ProcessTree = {
    lookup: async (pid) =>
      ({
        [process.pid]: { ppid: 4343, comm: 'bun' },
        4343: { ppid: 4242, comm: 'sh' },
        4242: { ppid: 1, comm: 'codex' },
      })[pid],
    isAlive: () => true,
  }

  it('reads /proc/<pid>/exe when ps gives a bare name (Linux)', async () => {
    const exe = async (pid: number) => (pid === 4242 ? '/home/u/.nvm/bin/codex' : undefined)
    expect(await codexAncestorBinary(linuxTree, process.pid, exe)).toBe('/home/u/.nvm/bin/codex')
    expect(await codexAncestorBinary(linuxTree, process.pid, async () => undefined)).toBeUndefined()
    expect(await codexAncestorBinary(linuxTree, process.pid, async () => 'codex')).toBeUndefined()
  })

  it('re-checks the version gate against the running binary', () => {
    const notOnPath = {
      id: 'codex',
      detected: false,
      supported: false,
      reason: 'codex CLI not found on PATH',
      evidence: [],
    } as unknown as AgentDetection
    const binary = (version: string): FoundBinary => ({
      path: '/opt/codex',
      realPath: '/opt/codex',
      version,
      source: 'running codex process',
    })
    const fresh = withRunningBinary(notOnPath, binary('0.160.1'))
    expect(fresh).toMatchObject({ detected: true, supported: true, version: '0.160.1' })
    expect(fresh.reason).toBeUndefined()
    const old = withRunningBinary(notOnPath, binary('0.150.0'))
    expect(old).toMatchObject({ supported: false, version: '0.150.0' })
    expect(old.reason).toContain('Codex CLI 0.150.0 is too old')
    const desktop = { id: 'codex-desktop', version: '26.1', evidence: [] } as unknown as AgentDetection
    expect(withRunningBinary(desktop, binary('0.160.1'))).toMatchObject({
      version: '26.1',
      engineVersion: '0.160.1',
    })
  })

  describe('in a join', () => {
    let w: JoinWorld
    beforeEach(async () => {
      w = await startJoinWorld()
    })
    afterEach(async () => {
      await w.stop()
    })

    async function fakeCodexAt(dir: string): Promise<string> {
      const path = joinPath(w.m.root, dir, 'codex')
      await mkdir(joinPath(w.m.root, dir), { recursive: true })
      await writeFile(path, FAKE_CODEX)
      await chmod(path, 0o755)
      return path
    }

    it('uses the running codex when codex is not on PATH', async () => {
      const running = await fakeCodexAt('npx-cache')
      const tree: ProcessTree = {
        lookup: async (pid) =>
          ({ [process.pid]: { ppid: 77, comm: 'bun' }, 77: { ppid: 1, comm: running } })[pid],
        isAlive: () => true,
      }
      const io = w.io(CODEX)
      const result = await runJoin(
        w.inviteUrl,
        { here: true, dryRun: true },
        io,
        w.deps({ processTree: tree }),
      )
      expect(output(io).err).toBe('')
      expect(result).toBe(0)
      expect(output(io).out).toContain('agent codex')
    })

    it('falls back to CODEX_CLI_PATH in config.toml, then to PATH detection', async () => {
      const configured = await fakeCodexAt('configured')
      await mkdir(joinPath(w.m.home, '.codex'), { recursive: true })
      await writeFile(
        joinPath(w.m.home, '.codex', 'config.toml'),
        `[env]\nCODEX_CLI_PATH = "${configured}"\n`,
      )
      const sys = w.m.sys()
      const base = [
        { id: 'codex', detected: false, supported: false, evidence: [] },
      ] as unknown as AgentDetection[]
      const [found] = await withRunningCodex(sys, base, undefined)
      expect(found).toMatchObject({
        supported: true,
        binary: { path: configured, source: 'config.toml CODEX_CLI_PATH' },
      })
      await writeFile(joinPath(w.m.home, '.codex', 'config.toml'), '')
      expect(await withRunningCodex(sys, base, undefined)).toEqual(base)
    })
  })
})
