/**
 * @agent-peers/dashboard: the member dashboard SPA. The CLI's hub command imports this module to
 * get the bundled files; it must stay free of React and browser code.
 */
import { EMBEDDED_ASSETS } from './generated/assets'

export const PACKAGE_NAME = '@agent-peers/dashboard'

/** Path below the mount (e.g. `index.html`, `chunk-ab12.js`) → file. Assignable to the hub's AssetMap. */
export type DashboardAssetMap = ReadonlyMap<string, Blob>

/** `[published path, on-disk or $bunfs path]` pairs, as the generated module lists them. */
export type EmbeddedAssetList = ReadonlyArray<readonly [string, string]>

export function toAssetMap(list: EmbeddedAssetList | undefined): DashboardAssetMap | undefined {
  if (list === undefined || list.length === 0) return undefined
  return new Map(list.map(([path, file]) => [path, Bun.file(file)] as const))
}

/**
 * The built SPA embedded by `bun run build` (works inside `bun build --compile` binaries, where the
 * files live in `$bunfs`), or undefined when the dashboard has not been built.
 */
export function dashboardAssets(): DashboardAssetMap | undefined {
  return toAssetMap(EMBEDDED_ASSETS)
}
