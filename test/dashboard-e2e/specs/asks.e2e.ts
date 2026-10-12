/**
 * 问答 (DASHBOARD §4.4, §12): the 全部 · 我问的 · 问我的 tabs show exactly what the member API
 * returns for each filter, and every answer state reads as the spec says.
 */
import { memberApi } from '../support/api'
import type { Page } from '../support/deps'
import { expect, test } from '../support/fixtures'

const threads = (page: Page) => page.getByRole('main').getByRole('article', { name: /^问答：/ })

test('asks tabs: all, asked by me, asked of me', async ({ page, hub, signIn }) => {
  await signIn()
  const api = memberApi(page, hub.info.url)
  await page.getByRole('link', { name: '全部问答' }).click()
  await expect(page).toHaveURL(`${hub.info.url}/app/asks`)
  await expect(page.getByRole('heading', { name: '问答', level: 1 })).toBeVisible()

  const all = (await api.asks('all')).asks
  await expect(threads(page)).toHaveCount(all.length)
  // Every answer state from the seed reads as §4.4 says.
  await expect(page.getByText('已回答', { exact: true }).first()).toBeVisible()
  await expect(page.getByText(/^对方没接这个问题：/)).toBeVisible()
  await expect(page.getByText(/^⊘ 没答上：/).first()).toBeVisible()
  await expect(page.getByText('对方不在线，上线后会收到').first()).toBeVisible()
  await expect(page.getByText('已送到，对方正在想，答完会自己回到你的对话').first()).toBeVisible()

  const filters = page.getByRole('radiogroup', { name: '筛选问答' })
  for (const [label, filter] of [
    ['我问的', 'mine'],
    ['问我的', 'to_me'],
    ['全部', 'all'],
  ] as const) {
    await filters.getByRole('radio', { name: label }).click()
    await expect(filters.getByRole('radio', { name: label })).toBeChecked()
    const expected = (await api.asks(filter)).asks
    expect(expected.length).toBeGreaterThan(0)
    await expect(threads(page)).toHaveCount(expected.length)
    await expect(threads(page).first()).toHaveAccessibleName(`问答：${firstLine(expected[0]?.question.text)}`)
  }
})

/** Thread cards are named after the question's first 40 characters. */
function firstLine(text: string | undefined): string {
  return (text ?? '').slice(0, 40)
}
