/**
 * A seeded demo hub for local preview and Playwright: `createHub` on loopback with the dashboard
 * served at `/app` and `/admin`, then the mockup's world seeded through real bridge sessions.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  consoleLogger,
  createHub,
  type Hub,
  type Logger,
  type StartInfo,
  type StaticSource,
} from '@agent-peers/hub'
import { dashboardAssets } from '../../src/index'
import { createDemoClock } from './clock'
import { createDemoIds } from './ids'
import { DEFAULT_DEMO_OPTIONS, type DemoOptions, type SeededDemo, seedDemo } from './seed'

const PACKAGE_DIR = join(import.meta.dir, '..', '..')

export interface DemoHubOptions extends Partial<DemoOptions> {
  readonly port?: number
  readonly adminPort?: number
  /** A directory for hub.db, or `:memory:` (the default). */
  readonly dataDir?: string
  /** Defaults to the embedded build, or a fresh build in a temp dir when there is none. */
  readonly source?: StaticSource
  readonly logger?: Logger
}

export interface DemoHub {
  readonly hub: Hub
  readonly info: StartInfo
  readonly url: string
  readonly adminUrl: string
  readonly seeded: SeededDemo
  stop(): Promise<void>
}

export interface ResolvedSource {
  readonly source: StaticSource
  readonly cleanup: () => Promise<void>
}

/** Builds the SPA into a temp dir (its own process, like `bun run build`), without touching src/. */
export async function buildToTemp(): Promise<ResolvedSource> {
  const work = await mkdtemp(join(tmpdir(), 'peers-demo-'))
  const outdir = join(work, 'dist')
  const proc = Bun.spawnSync(
    [
      process.execPath,
      join(PACKAGE_DIR, 'scripts', 'build.ts'),
      '--outdir',
      outdir,
      '--module',
      join(work, 'assets.ts'),
    ],
    { stdout: 'pipe', stderr: 'pipe', stdin: 'ignore' },
  )
  if (proc.exitCode !== 0) {
    await rm(work, { recursive: true, force: true })
    throw new Error(`dashboard build failed:\n${proc.stderr.toString()}`)
  }
  return { source: { dir: outdir }, cleanup: () => rm(work, { recursive: true, force: true }) }
}

export async function resolveSource(): Promise<ResolvedSource> {
  const assets = dashboardAssets()
  if (assets !== undefined) return { source: { assets }, cleanup: async () => undefined }
  return buildToTemp()
}

export async function startDemoHub(options: DemoHubOptions = {}): Promise<DemoHub> {
  const resolved = options.source === undefined ? await resolveSource() : undefined
  const source = options.source ?? resolved?.source
  const demoClock = createDemoClock()
  const hub = createHub({
    publicBind: '127.0.0.1',
    publicPort: options.port ?? 0,
    adminPort: options.adminPort ?? 0,
    dataDir: options.dataDir ?? ':memory:',
    bootstrapDefaultRoom: false,
    idleCloseMs: 0,
    minAdapter: '0.1.0',
    clock: demoClock.clock,
    // Fixed ids in seeding order, so faces keep their colors across runs (DASHBOARD §3, §12).
    newId: createDemoIds(),
    logger: options.logger ?? consoleLogger,
    http: source === undefined ? {} : { dashboard: source, admin: source },
  })
  const info = await hub.start()
  const url = `http://127.0.0.1:${info.publicPort}`
  const adminUrl = `http://127.0.0.1:${info.adminPort}`
  try {
    const seeded = await seedDemo(hub, url, demoClock, { ...DEFAULT_DEMO_OPTIONS, ...options })
    return {
      hub,
      info,
      url,
      adminUrl,
      seeded,
      stop: async () => {
        await seeded.close()
        await hub.stop()
        await resolved?.cleanup()
      },
    }
  } catch (error) {
    await hub.stop()
    await resolved?.cleanup()
    throw error
  }
}
