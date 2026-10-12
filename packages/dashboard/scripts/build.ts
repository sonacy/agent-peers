/**
 * `bun run build`: bundle the SPA into dist/ and embed it via src/generated/assets.ts.
 * `--outdir` and `--module` redirect both (the build test writes into a temp dir).
 */
import { parseArgs } from 'node:util'
import { buildSpa, writeAssetsModule } from './build-spa'

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: { outdir: { type: 'string' }, module: { type: 'string' } },
})

const result = await buildSpa({ outdir: values.outdir })
await writeAssetsModule(result.outdir, values.module)
process.stdout.write(`dashboard: ${result.files.length} files → ${result.outdir}\n`)
