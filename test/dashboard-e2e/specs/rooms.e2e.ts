/**
 * Room flows (DASHBOARD §4.2, §4.3, §12): create → copy invite → a second member knocks → let in;
 * remove an agent; kick and restore; close and reopen the invite; dissolve. Every step is checked
 * against the member API too, and the second member's view must change live.
 */
import { memberApi } from '../support/api'
import type { Page } from '../support/deps'
import { expect, test } from '../support/fixtures'

const roomUrl = (origin: string, id: string) => `${origin}/app/rooms/${id}`
const person = (page: Page, name: string) =>
  page.getByRole('region', { name: '房间里的人' }).getByRole('article', { name, exact: true })
const sidePanel = (page: Page) => page.getByRole('complementary', { name: '邀请和敲门' })

test('create a room, copy the invite, a teammate knocks and the owner lets them in', async ({
  page,
  hub,
  signIn,
  memberPage,
}) => {
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin: hub.info.url })
  await signIn()
  await page.getByRole('link', { name: '新建房间' }).click()
  const dialog = page.getByRole('dialog', { name: '新建房间' })
  await dialog.getByLabel('房间名').fill('设计评审')
  await dialog.getByLabel(/^链接名/).fill('design-review')
  await dialog.getByLabel(/^简介/).fill('设计稿评审，问问设计助手')
  await dialog.getByRole('button', { name: '建好了，去发邀请' }).click()

  await expect(page).toHaveURL(/\/app\/rooms\/[0-9A-Z]{26}/)
  await expect(page.getByRole('heading', { name: '设计评审', level: 1 })).toBeVisible()
  const roomId = page.url().split('/').at(-1) ?? ''
  const copy = page.getByRole('button', { name: '复制邀请' })
  await expect(copy).toBeFocused()
  await copy.click()
  await expect(page.getByText('已复制，粘到群里吧')).toBeVisible()
  const prompt = await page.evaluate(() => navigator.clipboard.readText())
  // The full join prompt (ONBOARDING §2), with the real, working invite link, never the masked code.
  expect(prompt).toContain('"设计评审"')
  expect(prompt).not.toContain('••••')
  const link = prompt.match(/\/j\/([A-Za-z0-9_-]+)/)?.[1]
  expect(link).toBeDefined()
  expect((await page.request.get(`${hub.info.url}/v0/invites/${link}`)).ok()).toBe(true)

  const wang = await memberPage('wang-fang')
  await wang.goto(`${hub.info.url}/app/rooms`)
  await wang.getByRole('searchbox', { name: '找房间' }).fill('design')
  await wang.getByRole('button', { name: '敲门申请 设计评审' }).click()
  const knock = wang.getByRole('dialog', { name: '敲 设计评审 的门' })
  await knock.getByLabel(/想说的话/).fill('想让设计助手看看新版首页')
  await knock.getByRole('button', { name: '敲门', exact: true }).click()
  await expect(wang.getByRole('listitem', { name: '设计评审' }).getByText('等开门')).toBeVisible()

  // The owner's open page shows the knock without a reload.
  const item = sidePanel(page).getByRole('listitem', { name: 'wang-fang 在敲门' })
  await expect(item).toContainText('想让设计助手看看新版首页')
  await item.getByRole('button', { name: '给 wang-fang 开门', exact: true }).click()
  await expect(item).toBeHidden()
  await expect(person(page, 'wang-fang')).toBeVisible()
  const detail = await memberApi(page, hub.info.url).room(roomId)
  expect(detail.people.map((p) => p.member).sort()).toEqual(['gulei', 'wang-fang'])
  expect(detail.knocks ?? []).toEqual([])

  // And the teammate's search row turns into a way in.
  await expect(wang.getByRole('link', { name: '进 设计评审 看看' })).toBeVisible()
})

test('remove one of my agents from a room', async ({ page, hub, signIn }) => {
  await signIn()
  const timely = hub.info.rooms.timely
  await page.goto(roomUrl(hub.info.url, timely))
  const mine = person(page, 'gulei')
  await expect(mine.getByRole('listitem')).toHaveCount(3)
  await mine.getByRole('button', { name: '把 调研 T3Code 项目 移出房间' }).click()
  await expect(mine.getByRole('listitem', { name: '调研 T3Code 项目' })).toBeHidden()
  await expect(mine.getByRole('listitem')).toHaveCount(2)
  await expect
    .poll(async () => {
      const detail = await memberApi(page, hub.info.url).room(timely)
      return detail.people
        .find((p) => p.is_me)
        ?.agents.map((a) => a.handle)
        .sort()
    })
    .toEqual(['prd2demo', 'sync'])

  // The home card loses the room tag (timely) too.
  await page.getByRole('link', { name: /^我的 agent/ }).click()
  const card = page.getByRole('article', { name: '调研 T3Code 项目' })
  await expect(card.getByRole('list', { name: '所在房间' })).not.toContainText('timely')
})

test('kick a person, then restore them', async ({ page, hub, signIn }) => {
  await signIn()
  const timely = hub.info.rooms.timely
  const api = memberApi(page, hub.info.url)
  await page.goto(roomUrl(hub.info.url, timely))
  await person(page, 'zhang-wei').getByRole('button', { name: '请 zhang-wei 出房间' }).click()
  const confirm = page.getByRole('dialog', { name: '请 zhang-wei 出房间' })
  await expect(confirm).toContainText('之前发出去的邀请都失效')
  await confirm.getByRole('button', { name: '请出房间' }).click()
  await expect(person(page, 'zhang-wei')).toBeHidden()
  await expect.poll(async () => (await api.room(timely)).kicked?.map((k) => k.member)).toEqual(['zhang-wei'])

  const kicked = sidePanel(page).getByRole('button', { name: '被请出的 1 人' })
  await kicked.click()
  await expect(kicked).toHaveAttribute('aria-expanded', 'true')
  await sidePanel(page).getByRole('button', { name: '恢复 zhang-wei' }).click()
  await expect(kicked).toBeHidden()
  await expect.poll(async () => (await api.room(timely)).kicked ?? []).toEqual([])
})

test('close the invite, then reopen it with a new code', async ({ page, hub, signIn }) => {
  await signIn()
  const timely = hub.info.rooms.timely
  const api = memberApi(page, hub.info.url)
  const before = (await api.room(timely)).invite?.code_masked
  await page.goto(roomUrl(hub.info.url, timely))
  await sidePanel(page).getByRole('button', { name: '关闭邀请' }).click()
  await expect(sidePanel(page).getByRole('heading', { name: '邀请已关闭' })).toBeVisible()
  await expect(sidePanel(page).getByRole('button', { name: '复制邀请' })).toBeHidden()
  await expect.poll(async () => (await api.room(timely)).invite?.state ?? 'none').not.toBe('active')

  await sidePanel(page).getByRole('button', { name: '重新开启（生成新邀请码）' }).click()
  await expect(sidePanel(page).getByRole('heading', { name: '拉朋友进来' })).toBeVisible()
  const after = await api.room(timely)
  expect(after.invite?.state).toBe('active')
  expect(after.invite?.code_masked).not.toBe(before)
  await expect(sidePanel(page).getByRole('figure', { name: '邀请预览' })).toContainText(
    after.invite?.code_masked ?? '',
  )
})

test('dissolve a room: typed confirmation, gone from my rooms, and the old link says so', async ({
  page,
  hub,
  signIn,
}) => {
  await signIn()
  const timely = hub.info.rooms.timely
  await page.goto(roomUrl(hub.info.url, timely))
  await page.getByRole('button', { name: '解散房间' }).click()
  const dialog = page.getByRole('dialog', { name: '解散房间' })
  const confirm = dialog.getByRole('button', { name: '解散房间' })
  // The page behind the dialog doesn't scroll, even though the hub's CSP blocks Radix's injected style.
  await expect.poll(() => page.evaluate(() => getComputedStyle(document.body).overflow)).toBe('hidden')
  await expect(confirm).toBeDisabled()
  await dialog.getByLabel(/确认/).fill('timel')
  await expect(confirm).toBeDisabled()
  await dialog.getByLabel(/确认/).fill('timely')
  await confirm.click()

  await expect(page).toHaveURL(`${hub.info.url}/app/rooms`)
  await expect(
    page.getByRole('list', { name: '我的房间' }).getByRole('link', { name: 'timely' }),
  ).toHaveCount(0)
  await expect.poll(() => memberApi(page, hub.info.url).roomStatus(timely)).not.toBe(200)

  await page.goto(roomUrl(hub.info.url, timely))
  await expect(page.getByText('这个房间已经解散了')).toBeVisible()
  await page.getByRole('link', { name: '回到房间列表' }).click()
  await expect(page).toHaveURL(`${hub.info.url}/app/rooms`)
})

test('a member leaves a room they joined', async ({ page, hub, signIn }) => {
  await signIn()
  const pay = hub.info.rooms.pay
  await page.goto(roomUrl(hub.info.url, pay))
  await expect(page.getByText('只有房主 zhang-wei 能拉人和管理成员', { exact: false })).toBeVisible()
  await page.getByRole('button', { name: '退出房间' }).click()
  await page.getByRole('dialog', { name: '退出房间' }).getByRole('button', { name: '退出房间' }).click()
  await expect(page).toHaveURL(`${hub.info.url}/app/rooms`)
  await expect(
    page.getByRole('list', { name: '我的房间' }).getByRole('link', { name: '支付联调' }),
  ).toHaveCount(0)
})
