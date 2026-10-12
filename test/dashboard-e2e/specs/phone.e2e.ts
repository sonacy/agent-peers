/**
 * Phone flows (DASHBOARD §2, §4.3 "Mobile", §9 "Phone layout"): the bottom tab bar, the + 新建
 * bottom sheet, the room tabs, and the person sheet (remove all agents, kick). No sideways scroll.
 */
import { memberApi } from '../support/api'
import type { Page } from '../support/deps'
import { expect, test } from '../support/fixtures'

async function expectNoSidewaysScroll(page: Page): Promise<void> {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
  expect(overflow).toBeLessThanOrEqual(0)
}

test('bottom tab bar and the new-room bottom sheet', async ({ page, hub, signIn }) => {
  await signIn()
  const tabs = page.getByRole('navigation', { name: '底部导航' })
  await expect(tabs).toBeVisible()
  await expect(page.getByRole('navigation', { name: '主导航' })).toBeHidden()
  await expectNoSidewaysScroll(page)

  await tabs.getByRole('link', { name: /房间/ }).click()
  await expect(page).toHaveURL(`${hub.info.url}/app/rooms`)
  await expectNoSidewaysScroll(page)
  await tabs.getByRole('link', { name: /问答/ }).click()
  await expect(page.getByRole('heading', { name: '问答', level: 1 })).toBeVisible()
  await expectNoSidewaysScroll(page)

  await page.getByRole('banner').getByRole('link', { name: '新建房间' }).click()
  const sheet = page.getByRole('dialog', { name: '新建房间' })
  await expect(sheet).toBeVisible()
  // A bottom sheet: pinned to the bottom edge, full width.
  const box = await sheet.boundingBox()
  const viewport = page.viewportSize()
  expect(box).not.toBeNull()
  expect(Math.round((box?.y ?? 0) + (box?.height ?? 0))).toBeGreaterThanOrEqual((viewport?.height ?? 0) - 1)
  expect(Math.round(box?.width ?? 0)).toBeGreaterThanOrEqual((viewport?.width ?? 0) - 1)
  for (const button of await sheet.getByRole('button').all()) {
    expect((await button.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44)
  }
})

test('room tabs and the person sheet: remove all agents, then kick', async ({ page, hub, signIn }) => {
  await signIn()
  const timely = hub.info.rooms.timely
  await page.goto(`${hub.info.url}/app/rooms/${timely}`)
  const tabs = page.getByRole('tablist', { name: '房间分区' })
  await expect(tabs.getByRole('tab', { name: '成员' })).toHaveAttribute('aria-selected', 'true')
  await expect(tabs.getByRole('tab', { name: '敲门 2' })).toBeVisible()
  await expectNoSidewaysScroll(page)

  await page.getByRole('button', { name: '管理 li-na' }).click()
  const sheet = page.getByRole('dialog', { name: '管理 li-na' })
  await sheet.getByRole('button', { name: '把他的 agent 全部移出' }).click()
  await expect(sheet).toBeHidden()
  await expect(page.getByRole('article', { name: 'li-na', exact: true })).toContainText('还没有 agent 进来')

  await page.getByRole('button', { name: '管理 zhang-wei' }).click()
  await page
    .getByRole('dialog', { name: '管理 zhang-wei' })
    .getByRole('button', { name: '请出房间（之后不能再用邀请码进来）' })
    .click()
  await page
    .getByRole('dialog', { name: '请 zhang-wei 出房间' })
    .getByRole('button', { name: '请出房间' })
    .click()
  await expect(page.getByRole('article', { name: 'zhang-wei', exact: true })).toBeHidden()
  const api = memberApi(page, hub.info.url)
  await expect.poll(async () => (await api.room(timely)).kicked?.map((k) => k.member)).toEqual(['zhang-wei'])

  await tabs.getByRole('tab', { name: '敲门 2' }).click()
  await expect(page.getByRole('button', { name: '被请出的 1 人' })).toBeVisible()
  await tabs.getByRole('tab', { name: '邀请' }).click()
  await expect(page.getByRole('button', { name: '复制邀请' })).toBeVisible()
})
