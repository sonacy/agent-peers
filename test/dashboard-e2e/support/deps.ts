/**
 * Playwright and axe, reached from `test/dashboard-e2e` (not a workspace, so bare specifiers do not
 * resolve here; they are devDependencies of `@agent-peers/dashboard`). Every e2e import of them goes
 * through this file. They are loaded with `require`, like the Playwright CLI loads itself, so the run
 * sees one copy of `@playwright/test` (their CommonJS entry points expose no ESM named exports).
 */
import { createRequire } from 'node:module'

const PACKAGES = '../../../packages/dashboard/node_modules'
const load = createRequire(import.meta.url)

type PlaywrightTest = typeof import('../../../packages/dashboard/node_modules/@playwright/test/index.js')
type AxePlaywright =
  typeof import('../../../packages/dashboard/node_modules/@axe-core/playwright/dist/index.js')

const playwright = load(`${PACKAGES}/@playwright/test`) as PlaywrightTest
const axe = load(`${PACKAGES}/@axe-core/playwright`) as AxePlaywright

export const { defineConfig, devices, expect, test } = playwright
export const AxeBuilder = axe.default

export type {
  Browser,
  BrowserContext,
  Locator,
  Page,
  TestInfo,
} from '../../../packages/dashboard/node_modules/@playwright/test/index.js'
