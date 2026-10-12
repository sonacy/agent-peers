/**
 * 我的 agent flows (DASHBOARD §4.1, §12): sign in, the agent cards, 接受提问 (through the UI and
 * from outside the page), and renaming an agent from the dashboard and from the agent itself.
 */
import { memberApi } from '../support/api'
import type { Page } from '../support/deps'
import { expect, test } from '../support/fixtures'

const agentCard = (page: Page, title: string) =>
  page.getByRole('region', { name: '我的 agent' }).getByRole('article', { name: title })

test('sign in: the one-time link opens the home screen with my agents', async ({ page, hub, signIn }) => {
  await signIn()
  await expect(page.getByText('你有 4 个 agent')).toBeVisible()
  await expect(page.getByRole('status').filter({ hasText: 'Core 已连接' })).toBeVisible()
  const cards = page.getByRole('region', { name: '我的 agent' }).getByRole('article')
  await expect(cards).toHaveCount(4)
  await expect(agentCard(page, 'prd2demo')).toContainText('离线')
  await expect(agentCard(page, '通用插件将 agent session 同步')).toContainText('正在忙')

  await page.getByRole('button', { name: '离线 1' }).click()
  await expect(cards).toHaveCount(1)
  await page.getByRole('button', { name: '全部 4' }).click()
  await expect(cards).toHaveCount(4)

  // The link is one-time: a second visit can't sign anyone in.
  const used = await hub.loginUrl('gulei')
  const other = await page.context().browser()?.newPage()
  if (other === undefined) throw new Error('no browser')
  await other.goto(used)
  await other.getByRole('button', { name: '继续' }).click()
  await expect(other).toHaveURL(/\/app\/$/)
  await other.goto(used)
  await other.getByRole('button', { name: '继续' }).click()
  await expect(other.getByText(/这个登录链接已经用过或过期了/)).toBeVisible()
  await other.close()
})

test('toggle accepting: the hub records it, and outside changes arrive live', async ({
  page,
  hub,
  signIn,
}) => {
  await signIn()
  const api = memberApi(page, hub.info.url)
  const sessionId = hub.info.sessions.t3code ?? ''
  const card = agentCard(page, '调研 T3Code 项目')
  const toggle = card.getByRole('switch', { name: '接受提问' })
  await expect(toggle).toBeChecked()

  await toggle.click()
  await expect(toggle).not.toBeChecked()
  await expect(card).toContainText('已暂停接受提问')
  await expect.poll(async () => (await api.session(sessionId)).accepting).toBe(false)

  // Someone (another tab, the CLI) turns it back on: the open page follows through SSE, no reload.
  await api.setAccepting(sessionId, true)
  await expect(toggle).toBeChecked()
  await expect(card).not.toContainText('已暂停接受提问')

  // 暂停 in the card menu is the same switch.
  await card.getByRole('button', { name: '调研 T3Code 项目 的更多操作' }).click()
  await page.getByRole('menuitem', { name: '暂停' }).click()
  await expect(toggle).not.toBeChecked()
  await expect.poll(async () => (await api.session(sessionId)).accepting).toBe(false)
})

test('rename an agent: from the dashboard, and live when the agent renames itself', async ({
  page,
  hub,
  signIn,
}) => {
  await signIn()
  const api = memberApi(page, hub.info.url)
  const card = agentCard(page, '调研 T3Code 项目')
  await card.getByRole('button', { name: '调研 T3Code 项目 的更多操作' }).click()
  await page.getByRole('menuitem', { name: '改名' }).click()
  const dialog = page.getByRole('dialog', { name: '改名' })
  await dialog.getByLabel('标题').fill('T3Code 竞品调研')
  await dialog.getByRole('button', { name: '保存' }).click()
  await expect(dialog).toBeHidden()
  await expect(agentCard(page, 'T3Code 竞品调研')).toBeVisible()
  await expect
    .poll(async () => (await api.session(hub.info.sessions.t3code ?? '')).title)
    .toBe('T3Code 竞品调研')

  // The agent renames itself (/peers:rename in that conversation): the card changes without a reload.
  await hub.renameAgent('popular', '本周热门 agent 项目')
  await expect(agentCard(page, '本周热门 agent 项目')).toBeVisible()
  await expect(agentCard(page, 'Recent popular agent projects')).toHaveCount(0)
})
