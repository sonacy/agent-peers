/** `bun run clean`: drop dist/ and restore the "not built" stub module. */
import { rm } from 'node:fs/promises'
import { DEFAULT_DIST, GENERATED_MODULE, renderStubModule } from './assets-module'

await rm(DEFAULT_DIST, { recursive: true, force: true })
await Bun.write(GENERATED_MODULE, renderStubModule())
