/**
 * The screen tour (DASHBOARD §12): every main screen in every viewport and theme, each checked with
 * axe (no serious/critical violations) and saved as a screenshot for design QA. Seeded with the full
 * mockup world (gulei's agents, timely / 支付联调 / llm-eval / the 120-person onboarding room).
 */
import { checkScreen } from '../support/checks'
import type { Page, TestInfo } from '../support/deps'
import { expect, test } from '../support/fixtures'

test.use({ world: 'full' })

const isPhone = (page: Page): boolean => (page.viewportSize()?.width ?? 1280) < 640

/** The big-room filter chips never clip or run under the 只看我的 switch. */
async function expectFilterRowFits(page: Page): Promise<void> {
  const chips = page.getByRole('group', { name: '按状态筛选' }).getByRole('button')
  await expect(chips).toHaveCount(4)
  for (const chip of await chips.all()) {
    // The label's width against the chip's own box (scrollWidth would count the 44px hit-area ::after).
    const { text, box } = await chip.evaluate((el) => {
      const range = document.createRange()
      range.selectNodeContents(el)
      return { text: range.getBoundingClientRect().width, box: el.clientWidth }
    })
    expect(text, `${await chip.textContent()} is clipped`).toBeLessThanOrEqual(box)
  }
  const row = await page.getByRole('group', { name: '按状态筛选' }).boundingBox()
  const toggle = await page.getByRole('switch').first().boundingBox()
  expect((row?.x ?? 0) + (row?.width ?? 0)).toBeLessThanOrEqual(toggle?.x ?? 0)
}

/** 解散房间 → the type-the-name confirm (phones open it from the hero's ⋯ sheet). */
async function dissolveConfirm(page: Page, info: TestInfo): Promise<void> {
  if (isPhone(page)) {
    await page.getByRole('button', { name: '管理房间 timely' }).click()
    await page
      .getByRole('dialog', { name: '管理房间 timely' })
      .getByRole('button', { name: '解散房间' })
      .click()
  } else {
    await page.getByRole('button', { name: '解散房间' }).click()
  }
  await expect(page.getByRole('dialog', { name: '解散房间' })).toBeVisible()
  await checkScreen(page, info, '18-dissolve-confirm')
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog')).toHaveCount(0)
}

/** The big room's 全部开门… confirm (phones: under the 敲门 tab). */
async function knockAllConfirm(page: Page, info: TestInfo): Promise<void> {
  if (isPhone(page)) await page.getByRole('tab', { name: /敲门/ }).click()
  await page.getByRole('button', { name: '全部开门…' }).click()
  await expect(page.getByRole('dialog', { name: '全部开门' })).toBeVisible()
  await checkScreen(page, info, '19-knock-all-confirm')
  await page.keyboard.press('Escape')
}

test('member screens: sign in, home, rooms, find, new room, asks', async ({ page, hub }, info) => {
  await page.goto(await hub.loginUrl('gulei'))
  await expect(page.getByRole('button', { name: '继续' })).toBeVisible()
  await checkScreen(page, info, '01-login')
  await page.getByRole('button', { name: '继续' }).click()

  await expect(page.getByRole('article', { name: '调研 T3Code 项目' })).toBeVisible()
  await expect(page.getByRole('region', { name: '刚刚聊过' }).getByRole('article').first()).toBeVisible()
  await checkScreen(page, info, '02-home')

  await page.goto(`${hub.info.url}/app/rooms`)
  await expect(page.getByRole('heading', { name: '房间', level: 1 })).toBeVisible()
  await expect(page.getByRole('link', { name: 'timely' })).toBeVisible()
  const found = page.getByRole('list', { name: '找到的房间' })
  await expect(found.getByRole('button', { name: '敲门申请 api-review' })).toBeVisible()
  await checkScreen(page, info, '03-rooms')

  // A term that only matches rooms gulei is not in: lime highlights, 敲门申请, and 等开门 / 撤回.
  await page.getByRole('searchbox').fill('api')
  await expect(found.getByRole('listitem')).toHaveCount(2)
  await expect(found.getByRole('button', { name: '撤回敲 API 文档 的门' })).toBeVisible()
  await expect(found.locator('mark').first()).toBeVisible()
  await checkScreen(page, info, '04-rooms-search')

  await found.getByRole('button', { name: '敲门申请 api-review' }).click()
  await expect(page.getByRole('dialog', { name: '敲 api-review 的门' })).toBeVisible()
  await checkScreen(page, info, '07-knock-dialog')
  await page.keyboard.press('Escape')

  await page.goto(`${hub.info.url}/app/rooms?new=1`)
  await expect(page.getByRole('dialog', { name: '新建房间' })).toBeVisible()
  await page.getByLabel('房间名').fill('设计评审')
  await checkScreen(page, info, '05-new-room')

  await page.goto(`${hub.info.url}/app/asks`)
  await expect(page.getByRole('heading', { name: '问答', level: 1 })).toBeVisible()
  await expect(page.getByRole('article').first()).toBeVisible()
  await checkScreen(page, info, '06-asks')
})

test('room screens: owner, member, invite closed, big room, gone', async ({ page, hub, signIn }, info) => {
  await signIn()
  const room = (id: string) => `${hub.info.url}/app/rooms/${id}`

  await page.goto(room(hub.info.rooms.timely))
  await expect(page.getByRole('heading', { name: 'timely', level: 1 })).toBeVisible()
  await expect(page.getByRole('article', { name: 'zhang-wei' })).toBeVisible()
  await checkScreen(page, info, '10-room-owner')
  await dissolveConfirm(page, info)
  if (isPhone(page)) {
    await page.getByRole('button', { name: '管理 zhang-wei' }).click()
    await expect(page.getByRole('dialog', { name: '管理 zhang-wei' })).toBeVisible()
    await checkScreen(page, info, '17-person-sheet')
    await page.keyboard.press('Escape')
    await page.getByRole('tab', { name: '邀请' }).click()
    await expect(page.getByRole('button', { name: '复制邀请' })).toBeVisible()
    await checkScreen(page, info, '11-room-owner-invite')
    await page.getByRole('tab', { name: /敲门/ }).click()
    await expect(page.getByRole('listitem', { name: 'wang-fang 在敲门' })).toBeVisible()
    await checkScreen(page, info, '12-room-owner-knocks')
  }

  await page.goto(room(hub.info.rooms.pay))
  await expect(page.getByRole('heading', { name: '支付联调', level: 1 })).toBeVisible()
  await expect(page.locator('main header').getByText('你是成员')).toBeVisible()
  await checkScreen(page, info, '13-room-member')

  await page.goto(room(hub.info.rooms.llmEval))
  await expect(page.getByRole('heading', { name: 'llm-eval', level: 1 })).toBeVisible()
  if (isPhone(page)) await page.getByRole('tab', { name: '邀请' }).click()
  await expect(page.getByRole('heading', { name: '邀请已关闭' })).toBeVisible()
  await checkScreen(page, info, '14-room-invite-closed')

  await page.goto(room(hub.info.rooms.onboarding))
  await expect(page.getByRole('heading', { name: 'onboarding-2026', level: 1 })).toBeVisible()
  await expect(page.getByRole('article').first()).toBeVisible()
  await expectFilterRowFits(page)
  await checkScreen(page, info, '15-room-big')
  await knockAllConfirm(page, info)

  await page.goto(room('01ZZZZZZZZZZZZZZZZZZZZZZZZ'))
  await expect(page.getByRole('link', { name: '回到房间列表' })).toBeVisible()
  await checkScreen(page, info, '16-room-gone')
})

test('operator screens: sign in and hub status', async ({ page, hub }, info) => {
  await page.goto(`${hub.info.adminUrl}/admin/`)
  await expect(page.getByRole('heading', { name: '登录 Core 运维' })).toBeVisible()
  await checkScreen(page, info, '20-operator-login')
  await page.getByLabel('管理令牌').fill(hub.info.adminToken)
  await page.getByRole('button', { name: '登录' }).click()
  await expect(page.getByRole('heading', { name: 'Core 状态' })).toBeVisible()
  await checkScreen(page, info, '21-operator')
})

test('Core disconnected screen', async ({ page, hub, signIn }, info) => {
  await signIn()
  await expect(page.getByRole('article', { name: '调研 T3Code 项目' })).toBeVisible()
  await hub.stop()
  await expect(page.getByRole('alert').filter({ hasText: '连不上 Core' })).toBeVisible()
  await expect(page.getByText('（上次的数据，等 Core…）')).toBeVisible()
  await checkScreen(page, info, '30-core-disconnected')
})
