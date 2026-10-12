/**
 * Dashboard e2e (DASHBOARD §12): Chromium against seeded demo hubs owned by the fixture server.
 * Each test gets its own hub, so tests run in parallel without seeing each other's changes.
 *
 * Projects: the screen tour (axe + screenshots) runs at 1280×800, 800×1000 and 390×844 in light and
 * dark; the flows run at 1280 light; the phone flows run at 390 light.
 * Run with `bun run test:dashboard-e2e` (screenshots land in `test/dashboard-e2e/screenshots/`).
 */
import { defineConfig, devices } from './support/deps'

type Theme = 'light' | 'dark'

const VIEWPORTS = {
  desktop: { width: 1280, height: 800 },
  tablet: { width: 800, height: 1000 },
  phone: { width: 390, height: 844 },
} as const

type ViewportName = keyof typeof VIEWPORTS

const FLOWS = /(home|rooms|asks|connection)\.e2e\.ts$/
const PHONE_FLOWS = /phone\.e2e\.ts$/
const SCREENS = /screens\.e2e\.ts$/

function project(viewport: ViewportName, theme: Theme, testMatch: RegExp) {
  const phone = viewport === 'phone'
  return {
    name: `${viewport}-${theme}`,
    testMatch,
    use: {
      ...devices['Desktop Chrome'],
      viewport: VIEWPORTS[viewport],
      colorScheme: theme,
      ...(phone ? { isMobile: true, hasTouch: true, deviceScaleFactor: 2 } : {}),
    },
  }
}

const tour = (Object.keys(VIEWPORTS) as ViewportName[]).flatMap((viewport) =>
  (['light', 'dark'] as const).map((theme) => {
    if (viewport === 'desktop' && theme === 'light') return project(viewport, theme, anyOf(SCREENS, FLOWS))
    if (viewport === 'phone' && theme === 'light')
      return project(viewport, theme, anyOf(SCREENS, PHONE_FLOWS))
    return project(viewport, theme, SCREENS)
  }),
)

function anyOf(...patterns: RegExp[]): RegExp {
  return new RegExp(patterns.map((p) => p.source).join('|'))
}

export default defineConfig({
  testDir: './specs',
  testMatch: /\.e2e\.ts$/,
  outputDir: './test-results',
  globalSetup: './global-setup.ts',
  // One worker: with several browsers loading pages from the one fixture process at once, a few
  // percent of page loads saw module chunks refused or stalled for ~8s (blank page). One at a time,
  // every run passes, and the whole suite still takes a couple of minutes.
  fullyParallel: false,
  workers: 1,
  forbidOnly: process.env.CI !== undefined,
  retries: process.env.CI === undefined ? 0 : 1,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: [['list'], ['html', { open: 'never', outputFolder: './playwright-report' }]],
  use: {
    locale: 'zh-CN',
    timezoneId: 'Asia/Shanghai',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    reducedMotion: 'reduce',
  },
  projects: tour,
})
