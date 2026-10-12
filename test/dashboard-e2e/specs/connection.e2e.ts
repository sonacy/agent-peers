/**
 * Core disconnected (DASHBOARD §5, §7, §12): stop the hub under an open dashboard, see the danger
 * banner, the red pill and the dimmed last data; start it again and come back without a reload.
 */
import { expect, test } from '../support/fixtures'

test('Core disconnected: banner, pill and stale data, then back after a restart', async ({
  page,
  hub,
  signIn,
}) => {
  await signIn()
  const pill = page.getByRole('banner').getByText(/Core 已连接|正在连 Core…|连不上 Core/)
  await expect(pill).toHaveText('Core 已连接')

  await hub.stop()
  const host = new URL(hub.info.url).host
  // Only the steady part is a live region; the countdown next to it ticks outside it.
  const banner = page.getByRole('alert').filter({ hasText: '连不上 Core' })
  await expect(banner).toHaveText(`连不上 Core（${host}）`)
  await expect(page.getByRole('main')).toContainText(/秒后重试|正在重试…/)
  const retry = page.getByRole('main').getByRole('button', { name: '现在重试' })
  await expect(retry).toBeVisible()
  await expect(pill).toHaveText('连不上 Core')
  await expect(page.getByText('（上次的数据，等 Core…）')).toBeVisible()
  // The last data stays on screen.
  await expect(page.getByRole('article', { name: '调研 T3Code 项目' })).toBeVisible()

  await hub.restart()
  await retry.click()
  await expect(pill).toHaveText('Core 已连接')
  await expect(banner).toBeHidden()
  await expect(page.getByText('（上次的数据，等 Core…）')).toBeHidden()

  // Signed in still (the session lives in the hub's database), and fresh data loads.
  await page.reload()
  await expect(page.getByRole('heading', { level: 1 })).toContainText('嗨，gulei')
  await expect(page.getByRole('region', { name: '我的 agent' }).getByRole('article')).toHaveCount(4)
})
