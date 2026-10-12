/**
 * Lint-level checks for files that only run elsewhere: docker/Dockerfile (parsed into instructions)
 * and .github/workflows/release.yml (parsed as YAML).
 */
import { describe, expect, it } from 'bun:test'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { resolveDataDir } from '../../packages/cli/src/commands/hub-options'
import { REPO_ROOT } from './helpers'

interface Instruction {
  readonly keyword: string
  readonly args: string
}

const KEYWORDS = new Set([
  'FROM',
  'RUN',
  'CMD',
  'LABEL',
  'EXPOSE',
  'ENV',
  'ADD',
  'COPY',
  'ENTRYPOINT',
  'VOLUME',
  'USER',
  'WORKDIR',
  'ARG',
  'ONBUILD',
  'STOPSIGNAL',
  'HEALTHCHECK',
  'SHELL',
])

/** Joins `\` continuations, drops comments and blank lines. */
function parseDockerfile(text: string): readonly Instruction[] {
  const logical = text
    .split('\n')
    .filter((line) => !/^\s*#/.test(line))
    .join('\n')
    .replace(/\\\n/g, ' ')
  return logical
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .map((line) => {
      const match = /^(\S+)\s+(.*)$/.exec(line)
      if (match?.[1] === undefined || match[2] === undefined) throw new Error(`bad line: ${line}`)
      return { keyword: match[1].toUpperCase(), args: match[2] }
    })
}

describe('docker/Dockerfile', async () => {
  const text = await readFile(join(REPO_ROOT, 'docker', 'Dockerfile'), 'utf8')
  const instructions = parseDockerfile(text)
  const all = (keyword: string) => instructions.filter((i) => i.keyword === keyword).map((i) => i.args)

  it('uses only known instructions, and exec-form entrypoint and volume', () => {
    for (const instruction of instructions) expect(KEYWORDS.has(instruction.keyword)).toBe(true)
    expect(all('ADD')).toEqual([])
    expect(JSON.parse(all('ENTRYPOINT')[0] ?? 'null')).toEqual(['/usr/local/bin/agent-peers', 'hub'])
    expect(JSON.parse(all('VOLUME')[0] ?? 'null')).toEqual(['/data'])
    expect(text).toContain('127.0.0.1:7338:7338')
  })

  it('keeps the admin listener unpublished unless opted in', () => {
    // No EXPOSE 7338 (so `-P` never publishes it) and no --admin-bind in the entrypoint: the hub's
    // loopback default holds and `docker exec … agent-peers invite` reaches it inside.
    expect(all('EXPOSE')).toEqual(['7337'])
    expect(all('ENTRYPOINT').join(' ')).not.toContain('--admin-bind')
    expect(text).toContain('docker exec agent-peers-hub agent-peers invite')
  })

  it('runs the hub in the data dir the admin commands resolve', () => {
    const env = all('ENV').find((args) => args.startsWith('AGENT_PEERS_HOME='))
    const home = env?.slice('AGENT_PEERS_HOME='.length) ?? ''
    const entrypoint: string[] = JSON.parse(all('ENTRYPOINT')[0] ?? '[]')
    const flag = entrypoint.indexOf('--data-dir')
    const hubDir = resolveDataDir(home, flag === -1 ? undefined : entrypoint[flag + 1])
    // `invite`, `rooms` and `hub rotate-admin-token` resolve the default from AGENT_PEERS_HOME.
    expect(hubDir).toBe(resolveDataDir(home, undefined))
    expect(hubDir.startsWith(`${JSON.parse(all('VOLUME')[0] ?? '[]')[0]}/`)).toBe(true)
  })

  it('builds with the pinned Bun and runs as non-root on distroless', async () => {
    const pkg = JSON.parse(await readFile(join(REPO_ROOT, 'package.json'), 'utf8'))
    const bunVersion = String(pkg.packageManager).replace('bun@', '')
    expect(all('ARG')).toContain(`BUN_VERSION=${bunVersion}`)
    const froms = all('FROM')
    expect(froms).toEqual([
      // biome-ignore lint/suspicious/noTemplateCurlyInString: Dockerfile variables
      '--platform=$BUILDPLATFORM oven/bun:${BUN_VERSION}@${BUN_DIGEST} AS build',
      // biome-ignore lint/suspicious/noTemplateCurlyInString: Dockerfile variables
      'gcr.io/distroless/cc-debian12:nonroot@${DISTROLESS_DIGEST}',
    ])
    const digests = all('ARG').filter((arg) => /_DIGEST=/.test(arg))
    expect(digests).toHaveLength(2)
    for (const arg of digests) expect(arg).toMatch(/_DIGEST=sha256:[0-9a-f]{64}$/)
    expect(instructions.at(-1)?.keyword).toBe('ENTRYPOINT')
    const finalStage = instructions.slice(instructions.findLastIndex((i) => i.keyword === 'FROM'))
    expect(finalStage.some((i) => i.keyword === 'RUN')).toBe(false)
    expect(finalStage.filter((i) => i.keyword === 'USER').map((i) => i.args)).toEqual(['65532:65532'])
    expect(
      finalStage.filter((i) => i.keyword === 'COPY').every((i) => i.args.startsWith('--from=build')),
    ).toBe(true)
    const build = all('RUN').join('\n')
    expect(build).toContain('bun install --frozen-lockfile')
    expect(build).toContain('packages/cli/scripts/release.ts --targets "linux-$arch"')
  })

  it('has a Dockerfile-specific ignore file that keeps node_modules and dist out', async () => {
    const ignore = await readFile(join(REPO_ROOT, 'docker', 'Dockerfile.dockerignore'), 'utf8')
    expect(ignore).toContain('**/node_modules')
    expect(ignore).toContain('**/dist')
  })
})

type Yaml = Record<string, unknown>

const obj = (value: unknown): Yaml => {
  if (typeof value !== 'object' || value === null) throw new Error('expected a mapping')
  return value as Yaml
}

describe('.github/workflows/release.yml', async () => {
  const text = await readFile(join(REPO_ROOT, '.github', 'workflows', 'release.yml'), 'utf8')
  const workflow = obj(Bun.YAML.parse(text))
  const jobs = obj(workflow.jobs)
  const steps = (job: string) => (obj(jobs[job]).steps as Yaml[]).map((step) => ({ ...step }))
  const runs = (job: string) =>
    steps(job)
      .map((step) => String(step.run ?? ''))
      .join('\n')

  it('runs on v* tags with read-only default permissions', () => {
    expect(workflow.on).toEqual({ push: { tags: ['v*'] } })
    expect(workflow.permissions).toEqual({ contents: 'read' })
    expect(Object.keys(jobs)).toEqual(['build', 'smoke', 'image', 'github', 'npm', 'docker'])
  })

  it('builds every target, checks the tag, and smoke-tests natively', () => {
    const build = runs('build')
    expect(build).toContain('jq -r .version packages/cli/package.json')
    expect(build).toContain('bun packages/cli/scripts/check-versions.ts --expect "$GITHUB_REF_NAME"')
    expect(build).toContain('bun packages/cli/scripts/release.ts')
    expect(build).toContain('bun packages/cli/scripts/install-sh.ts --check')
    expect(build).toContain('cp scripts/install.sh dist/release/install.sh')
    const include = obj(obj(obj(jobs.smoke).strategy).matrix).include as Yaml[]
    expect(include.map((entry) => entry.asset)).toEqual([
      'agent-peers-linux-x64',
      'agent-peers-linux-arm64',
      'agent-peers-darwin-arm64',
      'agent-peers-windows-x64.exe',
    ])
    expect(runs('smoke')).toContain('mcp --surface claude-code --selftest')
  })

  it('publishes npm platform packages before the launcher with OIDC permissions', () => {
    expect(obj(obj(jobs.npm).permissions)['id-token']).toBe('write')
    const npm = runs('npm')
    expect(npm).toContain('bun packages/cli/scripts/npm-stage.ts --version "$GITHUB_REF_NAME"')
    expect(npm).toContain('for dir in dist/npm/cli-* dist/npm/cli; do')
    expect(npm).toContain('npm publish "$dir" --access public')
    expect(obj(jobs.github).permissions).toMatchObject({ contents: 'write' })
    expect(runs('github')).toContain('gh release create')
  })

  it('pushes the hub image to GHCR from docker/Dockerfile', () => {
    expect(obj(obj(jobs.docker).permissions).packages).toBe('write')
    const push = steps('docker').find((step) => String(step.uses).startsWith('docker/build-push-action'))
    expect(obj(push?.with)).toMatchObject({ file: 'docker/Dockerfile', platforms: 'linux/amd64,linux/arm64' })
    // biome-ignore lint/suspicious/noTemplateCurlyInString: shell/workflow variables, not a template
    expect(text).toContain('ghcr.io/${{ github.repository_owner }}/agent-peers-hub')
  })

  it('builds and runs the hub image before anything is published', () => {
    const needs = (job: string) => obj(jobs[job]).needs
    expect(needs('github')).toEqual(['build', 'smoke', 'image'])
    expect(needs('npm')).toEqual(['build', 'smoke', 'image', 'github'])
    expect(needs('docker')).toEqual(['build', 'smoke', 'image'])
    const image = runs('image')
    expect(image).toContain('docker build --platform linux/amd64 -f docker/Dockerfile')
    expect(image).toContain('docker exec agent-peers-hub agent-peers rooms')
  })

  it('pins every action to a full commit SHA with its version as a comment', () => {
    const uses = Object.keys(jobs).flatMap((job) =>
      steps(job)
        .map((step) => step.uses)
        .filter(Boolean),
    )
    expect(uses.length).toBeGreaterThan(10)
    for (const action of uses) expect(String(action)).toMatch(/^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/)
    const lines = text.split('\n').filter((line) => /uses: /.test(line))
    for (const line of lines) expect(line).toMatch(/@[0-9a-f]{40} # v\d+\.\d+\.\d+$/)
  })
})
