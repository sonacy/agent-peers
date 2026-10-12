/**
 * scripts/install.sh and the hub's pinned /install.sh (one template) against a local fake release
 * server: download, checksum verification, install layout, argument passing and failure modes.
 */
import { afterAll, afterEach, describe, expect, it } from 'bun:test'
import { lstat, readFile, readlink, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { INSTALL_SH, runInstallSh } from '../../packages/cli/scripts/release/install-sh'
import { assetName, currentTarget } from '../../packages/cli/scripts/release/targets'
import { renderInstallScript, renderReleaseInstallScript } from '../../packages/hub/src/http/install-script'
import {
  cleanupDirs,
  currentBinary,
  type FakeRelease,
  fakeReleaseServer,
  installAssetName,
  isolatedEnv,
  REPO_ROOT,
  runProcess,
  sumsFor,
  tempDir,
} from './helpers'

let server: FakeRelease | undefined

afterEach(async () => {
  await server?.stop()
  server = undefined
})
afterAll(cleanupDirs)

/** A fake agent-peers: `--version` prints `version`, anything else records its argv and exits 0. */
const fakeBinary = (version: string): string => `#!/bin/sh
if [ "$1" = "--version" ] && [ $# -eq 1 ]; then echo "${version}"; exit 0; fi
printf '%s\\n' "$0" > "$RECORD"
for a in "$@"; do printf '%s\\n' "$a" >> "$RECORD"; done
`

interface Machine {
  readonly dir: string
  readonly peersHome: string
  readonly record: string
  readonly script: string
  env(extra?: Record<string, string>): Record<string, string>
}

async function machine(
  scriptText: string,
  files: ReadonlyMap<string, string | Uint8Array>,
): Promise<Machine> {
  server = fakeReleaseServer(files)
  const dir = await tempDir()
  const script = join(dir, 'install.sh')
  await writeFile(script, scriptText)
  const peersHome = join(dir, 'peers-home')
  const record = join(dir, 'argv.txt')
  const url = server.url
  return {
    dir,
    peersHome,
    record,
    script,
    env: (extra = {}) =>
      isolatedEnv(join(dir, 'home'), {
        AGENT_PEERS_HOME: peersHome,
        AGENT_PEERS_DOWNLOAD_URL: url,
        RECORD: record,
        ...extra,
      }),
  }
}

function release(binary: string, sums?: string): Map<string, string> {
  const files = new Map([[installAssetName(), binary]])
  return new Map([...files, ['SHA256SUMS', sums ?? sumsFor(files)]])
}

const recorded = async (m: Machine) => (await readFile(m.record, 'utf8')).trimEnd().split('\n')

describe('scripts/install.sh', () => {
  it('is generated from the hub template and up to date', async () => {
    expect(await runInstallSh(REPO_ROOT, true)).toEqual({ code: 0, message: `${INSTALL_SH}: up to date` })
    const text = await readFile(join(REPO_ROOT, INSTALL_SH), 'utf8')
    expect(text).toBe(renderReleaseInstallScript())
    expect(((await stat(join(REPO_ROOT, INSTALL_SH))).mode & 0o111) !== 0).toBe(true)
    // biome-ignore lint/suspicious/noTemplateCurlyInString: shell/workflow variables, not a template
    expect(text).toContain('VERSION="${AGENT_PEERS_VERSION:-latest}"')
    expect(text).toContain('REPO="sonacy/agent-peers"')
    for (const shell of ['sh', 'dash', 'bash']) {
      if (Bun.which(shell) === null) continue
      expect((await runProcess([shell, '-n', join(REPO_ROOT, INSTALL_SH)], isolatedEnv('/'))).code).toBe(0)
    }
  })

  it('writes and checks the generated file', async () => {
    const root = await tempDir()
    await Bun.write(join(root, 'scripts', '.keep'), '')
    expect((await runInstallSh(root, true)).code).toBe(1)
    expect(await runInstallSh(root, false)).toEqual({ code: 0, message: `wrote ${INSTALL_SH}` })
    expect((await runInstallSh(root, true)).code).toBe(0)
  })

  it('installs the latest release under <home>/bin and execs it with the remaining args', async () => {
    const m = await machine(renderReleaseInstallScript(), release(fakeBinary('9.9.9')))
    const ran = await runProcess(['sh', m.script, 'join', 'https://hub.example/j/ABC', '--here'], m.env())
    expect(ran.stderr).toContain(`installed ${join(m.peersHome, 'bin', 'agent-peers-9.9.9')}`)
    expect(ran.code).toBe(0)
    const installed = join(m.peersHome, 'bin', 'agent-peers-9.9.9')
    expect(await recorded(m)).toEqual([installed, 'join', 'https://hub.example/j/ABC', '--here'])
    expect(await readlink(join(m.peersHome, 'bin', 'current'))).toBe('agent-peers-9.9.9')
    expect(server?.requests).toEqual([installAssetName(), 'SHA256SUMS'])
  })

  it('takes a leading --version, and passes other args through untouched', async () => {
    const m = await machine(renderReleaseInstallScript(), release(fakeBinary('ignored')))
    const ran = await runProcess(['sh', m.script, '--version', 'v1.2.3', 'who', '--json'], m.env())
    expect(ran.code).toBe(0)
    expect(await recorded(m)).toEqual([join(m.peersHome, 'bin', 'agent-peers-1.2.3'), 'who', '--json'])
    const eq = await runProcess(['sh', m.script, '--version=2.0.0-rc.1', 'status'], m.env())
    expect(eq.code).toBe(0)
    expect((await recorded(m))[0]).toBe(join(m.peersHome, 'bin', 'agent-peers-2.0.0-rc.1'))
    const fromEnv = await runProcess(['sh', m.script, 'x'], m.env({ AGENT_PEERS_VERSION: '3.0.0' }))
    expect(fromEnv.code).toBe(0)
    expect(await recorded(m)).toEqual([join(m.peersHome, 'bin', 'agent-peers-3.0.0'), 'x'])
    // `--version` not followed by a version is the binary's own flag.
    const passthrough = await runProcess(
      ['sh', m.script, '--version'],
      m.env({ AGENT_PEERS_VERSION: '3.0.0' }),
    )
    expect(passthrough.stdout.trim()).toBe('ignored')
  })

  it('refuses a malformed version before downloading anything', async () => {
    const m = await machine(renderReleaseInstallScript(), release(fakeBinary('1.0.0')))
    const ran = await runProcess(['sh', m.script, 'x'], m.env({ AGENT_PEERS_VERSION: '1.0;rm' }))
    expect(ran.code).toBe(1)
    expect(ran.stderr).toContain('invalid version: 1.0;rm')
    expect(server?.requests).toEqual([])
  })

  it('stops on a checksum mismatch without running or installing anything', async () => {
    const files = release(fakeBinary('1.0.0'), sumsFor(new Map([[installAssetName(), 'something else']])))
    const m = await machine(renderReleaseInstallScript(), files)
    const ran = await runProcess(['sh', m.script, 'join', 'x'], m.env())
    expect(ran.code).toBe(1)
    expect(ran.stderr).toContain(`checksum mismatch for ${installAssetName()}`)
    expect(await Bun.file(m.record).exists()).toBe(false)
    expect(await lstat(m.peersHome).catch(() => undefined)).toBeUndefined()
  })

  it('stops when SHA256SUMS has no entry for the asset, or a download fails', async () => {
    const m = await machine(
      renderReleaseInstallScript(),
      release(fakeBinary('1.0.0'), `${'0'.repeat(64)}  other\n`),
    )
    const ran = await runProcess(['sh', m.script], m.env())
    expect(ran.code).toBe(1)
    expect(ran.stderr).toContain(`no checksum for ${installAssetName()} in SHA256SUMS`)
    await server?.stop()
    const missing = await machine(renderReleaseInstallScript(), new Map())
    const gone = await runProcess(['sh', missing.script], missing.env())
    expect(gone.code).toBe(1)
    expect(gone.stderr).toContain('download failed')
  })

  it('runs from the temp dir when the agent-peers home is not writable (agent sandbox)', async () => {
    const m = await machine(renderReleaseInstallScript(), release(fakeBinary('1.0.0')))
    await writeFile(m.peersHome, 'a file, not a directory')
    const ran = await runProcess(['sh', m.script, 'join', 'x', '--here'], m.env())
    expect(ran.code).toBe(0)
    expect(ran.stderr).toContain('running from a temporary directory')
    const [argv0, ...args] = await recorded(m)
    expect(argv0?.endsWith(`/${installAssetName()}`)).toBe(true)
    expect(args).toEqual(['join', 'x', '--here'])
  })
})

describe("the hub's pinned /install.sh", () => {
  it('installs the hub version and passes every argument (including --version) through', async () => {
    const m = await machine(renderInstallScript('1.2.3'), release(fakeBinary('ignored')))
    const shells = ['sh', ...(Bun.which('dash') === null ? [] : ['dash'])]
    for (const shell of shells) {
      const ran = await runProcess([shell, m.script, '--version', '0.0.1', 'join'], m.env())
      expect(ran.code).toBe(0)
      expect(await recorded(m)).toEqual([
        join(m.peersHome, 'bin', 'agent-peers-1.2.3'),
        '--version',
        '0.0.1',
        'join',
      ])
    }
  })
})

describe('install.sh with the real release binary', () => {
  it('downloads, verifies, installs and runs the compiled binary', async () => {
    const { dir } = await currentBinary()
    const bytes = new Uint8Array(await Bun.file(join(dir, assetName(currentTarget()))).arrayBuffer())
    const files = new Map<string, string | Uint8Array>([[installAssetName(), bytes]])
    const m = await machine(renderReleaseInstallScript(), new Map([...files, ['SHA256SUMS', sumsFor(files)]]))
    const ran = await runProcess(['sh', m.script, 'version'], m.env())
    expect(ran.code).toBe(0)
    expect(ran.stdout).toContain('agent-peers ')
    const pkg = JSON.parse(await readFile(join(REPO_ROOT, 'packages', 'cli', 'package.json'), 'utf8'))
    expect(await Bun.file(join(m.peersHome, 'bin', `agent-peers-${pkg.version}`)).exists()).toBe(true)
  }, 120_000)
})
