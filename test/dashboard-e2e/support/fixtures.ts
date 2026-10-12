/**
 * Test fixtures: `hub` is a freshly seeded demo hub for this test (disposed afterwards), and
 * `signIn` turns a page into a signed-in member through the real one-time login link (§1).
 */
import type { WorldSize } from '../fixture/contract'
import { createHubControl, type HubControl } from './control'
import { type Browser, type BrowserContext, test as base, expect, type Page } from './deps'

export const ME = 'gulei'

export interface E2EFixtures {
  /** Which demo world the test's hub is seeded with (`test.use({ world: 'full' })`). */
  readonly world: WorldSize
  readonly hub: HubControl
  /** Signs `page` (default: the test page) in as `member` (default: gulei) and lands on `/app/`. */
  readonly signIn: (member?: string, page?: Page) => Promise<void>
  /** A second, separate browser (own cookies), signed in as `member`. Closed after the test. */
  readonly memberPage: (member: string) => Promise<Page>
  /** Auto: uncaught page errors and CSP violations fail the test; console errors are attached. */
  readonly pageErrors: undefined
}

export async function signInAs(page: Page, hub: HubControl, member: string): Promise<void> {
  await page.goto(await hub.loginUrl(member))
  await page.getByRole('button', { name: '继续' }).click()
  await expect(page).toHaveURL(`${hub.info.url}/app/`)
  await expect(page.getByRole('heading', { level: 1 })).toContainText(`嗨，${member}`)
}

async function openContext(browser: Browser, page: Page): Promise<BrowserContext> {
  const viewport = page.viewportSize()
  return browser.newContext({
    ...(viewport === null ? {} : { viewport }),
    locale: 'zh-CN',
    timezoneId: 'Asia/Shanghai',
    reducedMotion: 'reduce',
  })
}

export const test = base.extend<E2EFixtures>({
  pageErrors: [
    async ({ page }, use, info) => {
      const uncaught: string[] = []
      const logged: string[] = []
      page.on('pageerror', (error) => uncaught.push(`${error.message}\n${error.stack ?? ''}`))
      page.on('console', (message) => {
        if (message.type() === 'error') logged.push(`${message.location().url}: ${message.text()}`)
      })
      await use(undefined)
      if (logged.length > 0) await info.attach('console-errors', { body: logged.join('\n') })
      expect(uncaught, 'uncaught errors in the page').toEqual([])
      // react-remove-scroll (Radix dialogs and menus) tries to inject a <style> element, which the
      // hub's CSP blocks; the dashboard ships that rule in its own CSS, so this one is expected.
      const csp = logged.filter(
        (line) => /Content Security Policy|script-src/.test(line) && !line.includes('Applying inline style'),
      )
      expect(csp, "CSP violations (the hub serves default-src 'self')").toEqual([])
    },
    { auto: true },
  ],
  world: ['small', { option: true }],
  hub: async ({ world }, use) => {
    const hub = await createHubControl({ size: world })
    try {
      await use(hub)
    } finally {
      await hub.dispose()
    }
  },
  signIn: async ({ page, hub }, use) => {
    await use((member = ME, target = page) => signInAs(target, hub, member))
  },
  memberPage: async ({ browser, page, hub }, use) => {
    const contexts: BrowserContext[] = []
    await use(async (member) => {
      const context = await openContext(browser, page)
      contexts.push(context)
      const other = await context.newPage()
      await signInAs(other, hub, member)
      return other
    })
    await Promise.all(contexts.map((c) => c.close()))
  },
})

export { expect }
