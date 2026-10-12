/**
 * Runs before the app bundle (its own module script, first in index.html). The hub serves the
 * dashboard under `Content-Security-Policy: default-src 'self'`, which forbids `eval`. Zod 4 probes
 * for it with `new Function` when the first object schema is built; the probe is caught, but the
 * browser still logs a CSP violation on every load. Zod reads this global config when it loads, and
 * jitless mode skips the probe. It has to be set before any chunk that builds schemas evaluates,
 * which an import at the top of main.tsx can't guarantee once the bundle is split.
 */
interface ZodGlobal {
  __zod_globalConfig?: Record<string, unknown>
}

export function configureZod(target: ZodGlobal = globalThis as ZodGlobal): void {
  target.__zod_globalConfig = { ...target.__zod_globalConfig, jitless: true }
}

configureZod()
