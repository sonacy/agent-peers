/**
 * The rest of the screen tour (DASHBOARD §5, §4.2 "Many rooms"): loading skeletons, a brand-new
 * member (onboarding hero and empty states), a teammate's outdated-plugin and boundary-tier cards,
 * the many-rooms table, and one agent keeping its face color on every page (§3).
 */
import { checkScreen } from '../support/checks'
import { expect, test } from '../support/fixtures'

test.use({ world: 'full' })

/** Long enough for the 300ms skeleton delay to pass and the screenshot to be taken. */
const SLOW_MS = 4_000

test('loading skeletons while the member API is slow', async ({ page, hub, signIn }, info) => {
  await signIn()
  await page.route(/\/v0\/me\/(sessions|asks)/, async (route) => {
    await new Promise((resolve) => setTimeout(resolve, SLOW_MS))
    await route.continue().catch(() => undefined)
  })
  await page.goto(`${hub.info.url}/app/`)
  await expect(page.getByRole('status').filter({ hasText: '正在加载问答…' })).toBeAttached()
  await checkScreen(page, info, '08-loading')
  await page.unrouteAll({ behavior: 'ignoreErrors' })
})

test('a brand-new member: onboarding hero and empty states', async ({ page, signIn }, info) => {
  await signIn('xiao-bai')
  await expect(page.getByRole('heading', { name: '三步，让你的 agent 交到朋友' })).toBeVisible()
  await checkScreen(page, info, '40-new-member-home')
  await page.getByRole('link', { name: '房间', exact: true }).click()
  await expect(page.getByRole('region', { name: '一个房间都还没有' })).toBeVisible()
  await checkScreen(page, info, '41-new-member-rooms')
  await page.getByRole('link', { name: '问答', exact: true }).click()
  await expect(page.getByRole('region', { name: '它们还没说过话' })).toBeVisible()
  await checkScreen(page, info, '42-new-member-asks')
})

test("a teammate's cards: outdated plugin and boundary tier", async ({ page, signIn }, info) => {
  await signIn('li-na')
  await expect(page.getByRole('button', { name: '复制升级命令' })).toBeVisible()
  await expect(page.getByRole('article', { name: '账单服务排查' })).toBeVisible()
  await checkScreen(page, info, '09-home-states')
})

test('many rooms: the table view, group tabs and the knock strip', async ({ page, hub, signIn }, info) => {
  await signIn('he-yu')
  await page.goto(`${hub.info.url}/app/rooms`)
  await expect(page.getByRole('heading', { name: /房间.*共 13 个/, level: 1 })).toBeVisible()
  await expect(page.getByText('我建的 8')).toBeVisible()
  await expect(page.getByText('等你开门')).toBeVisible()
  await checkScreen(page, info, '43-many-rooms')
})

test('one agent keeps its face color on home, room and Q&A pages', async ({ page, hub, signIn }) => {
  await signIn()
  const title = '调研 T3Code 项目'
  const color = (scope: ReturnType<typeof page.locator>) =>
    scope.locator('[data-face-color]').first().getAttribute('data-face-color')
  const home = await color(page.getByRole('article', { name: title }))
  expect(home).not.toBeNull()
  await page.goto(`${hub.info.url}/app/rooms/${hub.info.rooms.timely}`)
  await expect(page.getByRole('listitem', { name: title })).toBeVisible()
  expect(await color(page.getByRole('listitem', { name: title }))).toBe(home)
  await page.goto(`${hub.info.url}/app/asks`)
  const thread = page.getByRole('article').filter({ hasText: title }).first()
  await expect(thread).toBeVisible()
  const faces = await thread
    .locator('[data-face-color]')
    .evaluateAll((els) => els.map((el) => el.getAttribute('data-face-color')))
  expect(faces).toContain(home)
})
