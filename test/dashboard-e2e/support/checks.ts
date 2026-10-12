/**
 * Per-screen checks: axe (no serious or critical violations, WCAG 2.1 A/AA) and a full-page
 * screenshot for design QA in `screenshots/<project>/<name>.png`.
 */
import { join } from 'node:path'
import { AxeBuilder, expect, type Page, type TestInfo } from './deps'

const SCREENSHOTS = join(import.meta.dirname, '..', 'screenshots')
const AXE_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']
const BLOCKING = new Set(['serious', 'critical'])

export interface Violation {
  readonly id: string
  readonly impact: string
  readonly help: string
  readonly targets: readonly string[]
}

export async function axeViolations(page: Page): Promise<readonly Violation[]> {
  const results = await new AxeBuilder({ page }).withTags(AXE_TAGS).analyze()
  return results.violations
    .filter((v) => BLOCKING.has(v.impact ?? ''))
    .map((v) => ({
      id: v.id,
      impact: v.impact ?? '',
      help: v.help,
      targets: v.nodes.slice(0, 5).map((n) => n.target.join(' ')),
    }))
}

/** Fonts loaded and no entrance animation running, so the picture is the settled screen. */
export async function settle(page: Page): Promise<void> {
  await page.evaluate(async () => {
    await document.fonts.ready
    const finite = document
      .getAnimations()
      .filter((a) => a.effect?.getComputedTiming().iterations !== Number.POSITIVE_INFINITY)
    await Promise.all(finite.map((a) => a.finished.catch(() => undefined)))
  })
}

/**
 * The full page; on phones also the first screen as seen (`-fold`), because a full-page capture
 * draws the fixed bottom tab bar where the first viewport ends, not at the bottom.
 */
export async function screenshot(page: Page, info: TestInfo, name: string): Promise<void> {
  await settle(page)
  const dir = join(SCREENSHOTS, info.project.name)
  await page.screenshot({ path: join(dir, `${name}.png`), fullPage: true })
  if ((page.viewportSize()?.width ?? 1280) < 640)
    await page.screenshot({ path: join(dir, `${name}-fold.png`) })
}

/** The screenshot, then axe as a soft assertion: one run reports every screen's violations. */
export async function checkScreen(page: Page, info: TestInfo, name: string): Promise<void> {
  await screenshot(page, info, name)
  const violations = await axeViolations(page)
  expect.soft(violations, `axe on ${name} (${info.project.name})`).toEqual([])
}
