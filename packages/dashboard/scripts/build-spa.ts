/**
 * Bundles `src/index.html` (React + Tailwind) into a static SPA mounted at `/app/`.
 * Run it as its own process (`scripts/build.ts`): bun-plugin-tailwind fails to resolve some modules
 * when Bun.build runs inside the `bun test` runtime.
 */
import { rm } from 'node:fs/promises'
import { basename, join } from 'node:path'
import tailwind from 'bun-plugin-tailwind'
import { DEFAULT_DIST, GENERATED_MODULE, listFiles, PACKAGE_DIR, renderAssetsModule } from './assets-module'
import { injectBootScript } from './boot-script'

export interface BuildOptions {
  readonly outdir?: string
  /** Absolute URL prefix for bundled files: SPA routes like `/app/rooms/1` load `/app/chunk.js`. */
  readonly publicPath?: string
  readonly minify?: boolean
}

export interface BuildResult {
  readonly outdir: string
  readonly files: readonly string[]
}

export async function buildSpa(options: BuildOptions = {}): Promise<BuildResult> {
  const outdir = options.outdir ?? DEFAULT_DIST
  await rm(outdir, { recursive: true, force: true })
  const result = await Bun.build({
    entrypoints: [join(PACKAGE_DIR, 'src', 'index.html')],
    outdir,
    target: 'browser',
    plugins: [tailwind],
    publicPath: options.publicPath ?? '/app/',
    minify: options.minify ?? true,
    splitting: true,
    sourcemap: 'none',
    // Fonts must be same-origin files: CSP `default-src 'self'` blocks data: URIs.
    loader: { '.woff2': 'file', '.svg': 'file' },
    define: { 'process.env.NODE_ENV': '"production"' },
  })
  assertBuilt(result)
  await addBootScript(outdir, options.publicPath ?? '/app/', options.minify ?? true)
  return { outdir, files: await listFiles(outdir) }
}

function assertBuilt(result: Awaited<ReturnType<typeof Bun.build>>): void {
  if (result.success) return
  const messages = result.logs.map((log) => String(log.message ?? log)).join('\n')
  throw new Error(`dashboard build failed:\n${messages}`)
}

/**
 * `src/boot.ts` must run before any bundled module (it configures zod before schemas are built), so
 * it is its own classic script, ahead of the module entry. Bun's HTML bundling merges every
 * `<script>` of index.html into one entry, so it is built and injected separately.
 */
async function addBootScript(outdir: string, publicPath: string, minify: boolean): Promise<void> {
  const result = await Bun.build({
    entrypoints: [join(PACKAGE_DIR, 'src', 'boot.ts')],
    outdir,
    target: 'browser',
    format: 'iife',
    minify,
    naming: 'boot-[hash].[ext]',
  })
  assertBuilt(result)
  const name = basename(result.outputs[0]?.path ?? '')
  const indexFile = join(outdir, 'index.html')
  await Bun.write(indexFile, injectBootScript(await Bun.file(indexFile).text(), `${publicPath}${name}`))
}

/** Writes the generated module that embeds every built file for compiled binaries. */
export async function writeAssetsModule(
  distDir: string,
  moduleFile: string = GENERATED_MODULE,
): Promise<string> {
  const files = await listFiles(distDir)
  const source = renderAssetsModule(files, distDir, join(moduleFile, '..'))
  await Bun.write(moduleFile, source)
  return source
}
