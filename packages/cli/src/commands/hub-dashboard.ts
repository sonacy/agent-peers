/**
 * The dashboard SPA for `/app` and `/admin` (DASHBOARD.md): `dashboardAssets()` from
 * `@agent-peers/dashboard` when that package is present and built, otherwise nothing (the hub then
 * serves a placeholder page). The import is dynamic so the CLI builds and runs without it.
 */
import type { AssetBody, AssetMap } from '@agent-peers/hub'

export const DASHBOARD_MODULE = '@agent-peers/dashboard'

/** `warn` hears about a dashboard module that exists but fails to load. */
export type DashboardLoader = (warn: (message: string) => void) => Promise<AssetMap | undefined>

const isAssetBody = (value: unknown): value is AssetBody =>
  typeof value === 'string' || value instanceof Uint8Array || value instanceof Blob

/** Accepts a Map or a plain record of path → file; anything else is ignored. */
export function asAssetMap(value: unknown): AssetMap | undefined {
  if (value instanceof Map) {
    const entries = [...value.entries()].filter(
      (entry): entry is [string, AssetBody] => typeof entry[0] === 'string' && isAssetBody(entry[1]),
    )
    return entries.length > 0 ? new Map(entries) : undefined
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const entries = Object.entries(value).filter((entry): entry is [string, AssetBody] => isAssetBody(entry[1]))
  return entries.length > 0 ? Object.freeze(Object.fromEntries(entries)) : undefined
}

/** Calls the module's `dashboardAssets()`; undefined when it is missing, unbuilt or broken. */
export function assetsFromModule(mod: unknown): AssetMap | undefined {
  if (typeof mod !== 'object' || mod === null || !('dashboardAssets' in mod)) return undefined
  const { dashboardAssets } = mod as { dashboardAssets: unknown }
  if (typeof dashboardAssets !== 'function') return undefined
  return asAssetMap((dashboardAssets as () => unknown)())
}

/** A missing package is the normal case for a source checkout; only other failures are reported. */
export function isModuleMissing(error: unknown, specifier: string): boolean {
  const code = typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined
  if (code === 'ERR_MODULE_NOT_FOUND' || code === 'MODULE_NOT_FOUND') return true
  const message = error instanceof Error ? error.message : String(error)
  return message.includes(specifier) && /cannot find|not found|could not resolve/i.test(message)
}

export function dashboardLoader(specifier: string = DASHBOARD_MODULE): DashboardLoader {
  return async (warn) => {
    let mod: unknown
    try {
      mod = await import(specifier)
    } catch (error) {
      if (!isModuleMissing(error, specifier)) warn(`dashboard failed to load: ${String(error)}`)
      return undefined
    }
    try {
      return assetsFromModule(mod)
    } catch (error) {
      warn(`dashboard assets failed to load: ${String(error)}`)
      return undefined
    }
  }
}

export const loadDashboardAssets: DashboardLoader = dashboardLoader()
