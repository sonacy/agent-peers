import '../helpers/dom'
import { describe, expect, it } from 'bun:test'
import { within } from '@testing-library/react'
import { memberHub, renderApp } from '../helpers/app'
import { apiError } from '../helpers/fake-hub'
import { card, myRoom } from '../helpers/fixtures'
import { screen, setupUi, user, waitFor } from '../helpers/render'
import { invite, JOIN_PROMPT, knock, searchRoom } from '../helpers/room-fixtures'

setupUi()

const SEARCH = [
  searchRoom('r_api', 'api-review'),
  searchRoom('r_pay', 'pay', { display_name: '支付联调', owner: 'zhangwei', member_count: 5 }),
  searchRoom('r_design', 'design', { owner: 'wangfang' }),
  searchRoom('r_timely', 'timely', { owner: 'gulei', my_state: 'member' }),
]

/** The hub's view of my pending knocks: search rows and /v0/me/knocks both follow it. */
function hub(routes = {}, mine = [knock('k_design', 'gulei', { room_id: 'r_design' })]) {
  return memberHub({
    'GET /v0/me/rooms': {
      rooms: [
        myRoom({ pending_knocks: 2, people: 3, agents: 5 }),
        myRoom({ id: 'r_pay', name: 'pay', role: 'member', people: 5, agents: 7 }),
      ],
    },
    'GET /v0/me/sessions': { sessions: [card()] },
    'GET /v0/rooms/search': (call) => {
      const q = new URL(`http://x${call.path}`).searchParams.get('q') ?? ''
      const rooms = SEARCH.filter((r) => r.name.includes(q) || r.owner.includes(q)).map((r) =>
        r.my_state === 'member'
          ? r
          : { ...r, my_state: mine.some((k) => k.room_id === r.room_id) ? 'knocking' : 'none' },
      )
      return { rooms }
    },
    'GET /v0/me/knocks': () => ({ knocks: mine }),
    ...routes,
  })
}

const results = () => screen().getByRole('list', { name: '找到的房间' })

describe('rooms: 找房间', () => {
  it('suggests discoverable rooms I am not in, with knock states', async () => {
    renderApp('/app/rooms', hub())
    expect(await screen().findByRole('heading', { name: '房间', level: 1 })).toBeDefined()
    await screen().findByRole('list', { name: '找到的房间' })
    const rows = within(results()).getAllByRole('listitem')
    expect(rows.map((r: HTMLElement) => r.getAttribute('aria-label'))).toEqual([
      'api-review',
      '支付联调',
      'design',
    ])
    expect(within(results()).getByText(/房主 zhangwei/).textContent).toBe('房主 zhangwei · 5 人')
    expect(within(results()).getByRole('button', { name: '敲门申请 api-review' })).toBeDefined()
    const design = within(results()).getByRole('listitem', { name: 'design' })
    expect(within(design).getByText('等开门')).toBeDefined()
    expect(within(design).getByRole('button', { name: '撤回敲 design 的门' })).toBeDefined()
  })

  it('debounces the search and highlights matches in lime', async () => {
    const h = hub()
    renderApp('/app/rooms', h)
    await screen().findByRole('list', { name: '找到的房间' })
    const u = user()
    await u.type(screen().getByRole('searchbox', { name: '找房间' }), 'api')
    await waitFor(() => expect(h.calls.some((c) => c.path.endsWith('q=api'))).toBe(true))
    expect(h.calls.filter((c) => /q=a$|q=ap$/.test(c.path))).toHaveLength(0)
    await waitFor(() => expect(within(results()).getAllByRole('listitem')).toHaveLength(1))
    const mark = results().querySelector('mark')
    expect(mark?.textContent).toBe('api')
    expect(mark?.className).toContain('bg-lime')
  })

  it('says why nothing matched', async () => {
    renderApp('/app/rooms', hub())
    await screen().findByRole('list', { name: '找到的房间' })
    await user().type(screen().getByRole('searchbox', { name: '找房间' }), 'zzz')
    expect(await screen().findByText(/没找到「zzz」/)).toBeDefined()
  })

  it('knocks with a note, then shows 等开门 and lets me withdraw', async () => {
    const mine = [knock('k_design', 'gulei', { room_id: 'r_design' })]
    const fresh = knock('k_new', 'gulei', { room_id: 'r_api' })
    const h = hub(
      {
        'POST /v0/me/rooms/r_api/knock': () => {
          mine.push(fresh)
          return { knock: fresh }
        },
        'DELETE /v0/me/knocks/k_new': () => {
          mine.pop()
          return { ok: true }
        },
      },
      mine,
    )
    renderApp('/app/rooms', h)
    const u = user()
    await u.click(await screen().findByRole('button', { name: '敲门申请 api-review' }))
    const dialog = await screen().findByRole('dialog', { name: '敲 api-review 的门' })
    await u.type(within(dialog).getByRole('textbox'), '想问问接口规范')
    await u.click(within(dialog).getByRole('button', { name: '敲门' }))
    const row = () => within(results()).getByRole('listitem', { name: 'api-review' })
    await waitFor(() => expect(within(row()).getByText('等开门')).toBeDefined())
    expect(h.callsTo('POST /v0/me/rooms/r_api/knock')[0]?.body).toEqual({ note: '想问问接口规范' })
    expect(await screen().findByText('敲过 api-review 的门了，等房主开门')).toBeDefined()
    await u.click(within(row()).getByRole('button', { name: '撤回敲 api-review 的门' }))
    await waitFor(() => expect(h.callsTo('DELETE /v0/me/knocks/k_new')).toHaveLength(1))
    expect(await screen().findByText('撤回了敲 api-review 的门')).toBeDefined()
    expect(within(row()).getByRole('button', { name: '敲门申请 api-review' })).toBeDefined()
  })

  it('rolls the knock back with a toast when the hub refuses', async () => {
    const h = hub({ 'POST /v0/me/rooms/r_api/knock': () => apiError('rate_limited', 429, 'slow', 4000) })
    renderApp('/app/rooms', h)
    const u = user()
    await u.click(await screen().findByRole('button', { name: '敲门申请 api-review' }))
    const dialog = await screen().findByRole('dialog')
    await u.click(within(dialog).getByRole('button', { name: '敲门' }))
    expect(await screen().findByText('门没敲成')).toBeDefined()
    expect(screen().getByText('操作太快了，4 秒后再试。')).toBeDefined()
    expect(h.callsTo('POST /v0/me/rooms/r_api/knock')[0]?.body).toEqual({})
    expect(await screen().findByRole('button', { name: '敲门申请 api-review' })).toBeDefined()
  })

  it('treats knock_pending as already waiting', async () => {
    const h = hub({ 'POST /v0/me/rooms/r_api/knock': () => apiError('knock_pending', 409) })
    renderApp('/app/rooms', h)
    const u = user()
    await u.click(await screen().findByRole('button', { name: '敲门申请 api-review' }))
    await u.click(within(await screen().findByRole('dialog')).getByRole('button', { name: '敲门' }))
    expect(await screen().findByText('敲过 api-review 的门了，等房主开门')).toBeDefined()
  })

  it('withdraws using my knocks, and toasts when that fails', async () => {
    const h = hub({ 'DELETE /v0/me/knocks/k_design': () => apiError('forbidden', 403) })
    renderApp('/app/rooms', h)
    const u = user()
    const design = await screen().findByRole('listitem', { name: 'design' })
    await u.click(within(design).getByRole('button', { name: '撤回敲 design 的门' }))
    expect(await screen().findByText('没撤回')).toBeDefined()
    expect(h.callsTo('DELETE /v0/me/knocks/k_design')).toHaveLength(1)
  })

  it('looks my knock up first when my knocks are not loaded yet', async () => {
    let ready = false
    const mine = [knock('k_design', 'gulei', { room_id: 'r_design' })]
    const h = hub(
      {
        'GET /v0/me/knocks': () => (ready ? { knocks: mine } : apiError('internal', 500)),
        'DELETE /v0/me/knocks/k_design': { ok: true },
      },
      mine,
    )
    renderApp('/app/rooms', h)
    const design = await screen().findByRole('listitem', { name: 'design' })
    ready = true
    await user().click(within(design).getByRole('button', { name: '撤回敲 design 的门' }))
    await waitFor(() => expect(h.callsTo('DELETE /v0/me/knocks/k_design')).toHaveLength(1))
  })

  it('links rooms I am already in', async () => {
    renderApp('/app/rooms', hub())
    await screen().findByRole('list', { name: '找到的房间' })
    await user().type(screen().getByRole('searchbox', { name: '找房间' }), 'timely')
    const go = await screen().findByRole('link', { name: '进 timely 看看' })
    expect(go.getAttribute('href')).toBe('/app/rooms/r_timely')
  })

  it('shows a retry banner when search fails', async () => {
    renderApp('/app/rooms', hub({ 'GET /v0/rooms/search': () => apiError('internal', 500) }))
    expect(await screen().findByText('房间没搜出来', {}, { timeout: 3000 })).toBeDefined()
  })
})

function describedBy(el: HTMLElement): string {
  return (el.getAttribute('aria-describedby') ?? '')
    .split(' ')
    .map((id) => document.getElementById(id)?.textContent?.trim() ?? '')
    .join(' ')
}

describe('rooms: 我的房间', () => {
  it('renders room cards with role chips, counts and the knock badge', async () => {
    renderApp('/app/rooms', hub())
    const timely = await screen().findByRole('link', { name: 'timely' })
    expect(timely.getAttribute('href')).toBe('/app/rooms/r_timely')
    expect(within(timely).getByText('房主')).toBeDefined()
    expect(within(timely).getByText('3 人 · 5 个 agent')).toBeDefined()
    expect(within(timely).getByText(/2 人在敲门/)).toBeDefined()
    expect(within(timely).getByRole('img', { name: '5 个 agent' })).toBeDefined()
    // The link is named by the room alone; screen readers get the rest as its description.
    expect(describedBy(timely)).toBe('房主 gulei 房主 3 人 · 5 个 agent 2 人在敲门')
    const pay = screen().getByRole('link', { name: 'pay' })
    expect(within(pay).getByText('成员')).toBeDefined()
    expect(within(pay).queryByText(/人在敲门/)).toBeNull()
    expect(describedBy(pay)).not.toContain('人在敲门')
  })

  it('shows the empty state with create and find', async () => {
    renderApp('/app/rooms', memberHub({ 'GET /v0/rooms/search': { rooms: [] } }))
    expect(await screen().findByRole('region', { name: '一个房间都还没有' })).toBeDefined()
    const u = user()
    await u.click(screen().getByRole('button', { name: '找房间' }))
    expect(document.activeElement).toBe(screen().getByRole('searchbox', { name: '找房间' }))
    await u.click(
      within(screen().getByRole('region', { name: '一个房间都还没有' })).getByRole('button', {
        name: '新建房间',
      }),
    )
    expect(await screen().findByRole('dialog', { name: '新建房间' })).toBeDefined()
  })

  it('shows a retry banner when my rooms fail to load', async () => {
    renderApp('/app/rooms', hub({ 'GET /v0/me/rooms': () => apiError('internal', 500) }))
    expect(await screen().findByText('没拿到你的房间列表', {}, { timeout: 3000 })).toBeDefined()
  })

  it('focuses the search box for ?find=1', async () => {
    renderApp('/app/rooms?find=1', hub())
    await waitFor(() =>
      expect(document.activeElement).toBe(screen().getByRole('searchbox', { name: '找房间' })),
    )
  })
})

describe('rooms: 新建房间', () => {
  const created = {
    room: {
      room_id: 'r_new',
      name: 'room-abc',
      display_name: '支付联调',
      owner: 'gulei',
      created_at: Date.now(),
    },
    invite: invite({ room_id: 'r_new' }),
    invite_url: 'https://hub.example.com/j/X',
    join_prompt: JOIN_PROMPT,
  }

  it('derives the slug from a Chinese name and opens the room with the invite focused', async () => {
    const h = hub({ 'POST /v0/me/rooms': created, 'GET /v0/me/rooms/r_new': () => new Promise(() => {}) })
    renderApp('/app/rooms?new=1', h)
    const dialog = await screen().findByRole('dialog', { name: '新建房间' })
    const u = user()
    await u.type(within(dialog).getByRole('textbox', { name: '房间名' }), '支付联调')
    const slug = within(dialog).getByRole('textbox', { name: /链接名/ }) as HTMLInputElement
    expect(slug.value).toMatch(/^room-[a-z0-9]+$/)
    await u.type(within(dialog).getByRole('textbox', { name: /简介/ }), '对接口')
    await u.click(within(dialog).getByRole('switch', { name: /能被找到/ }))
    await u.click(within(dialog).getByRole('button', { name: '建好了，去发邀请' }))
    await waitFor(() => expect(window.location.pathname).toBe('/app/rooms/r_new'))
    expect(h.callsTo('POST /v0/me/rooms')[0]?.body).toEqual({
      name: slug.value,
      display_name: '支付联调',
      description: '对接口',
      discoverable: false,
    })
    expect(await screen().findByRole('heading', { name: '支付联调', level: 1 })).toBeDefined()
    await waitFor(() => expect(document.activeElement?.textContent).toContain('复制邀请'))
  })

  it('keeps an edited slug, rejects bad ones, and shows hub errors inline', async () => {
    const h = hub({ 'POST /v0/me/rooms': () => apiError('invalid_name', 400) })
    renderApp('/app/rooms', h)
    const u = user()
    await u.click(await screen().findByRole('button', { name: '新建房间' }))
    const dialog = await screen().findByRole('dialog', { name: '新建房间' })
    await u.type(within(dialog).getByRole('textbox', { name: '房间名' }), 'API Review')
    const slug = within(dialog).getByRole('textbox', { name: /链接名/ }) as HTMLInputElement
    expect(slug.value).toBe('api-review')
    await u.clear(slug)
    await u.type(slug, '-bad')
    expect(slug.getAttribute('aria-invalid')).toBe('true')
    expect(within(dialog).getByRole('button', { name: '建好了，去发邀请' }).hasAttribute('disabled')).toBe(
      true,
    )
    await u.clear(slug)
    await u.type(slug, 'apireview')
    await u.click(within(dialog).getByRole('button', { name: '建好了，去发邀请' }))
    expect(await within(dialog).findByRole('alert')).toBeDefined()
    expect(within(dialog).getByRole('alert').textContent).toContain('名字只能用小写字母')
    expect(h.callsTo('POST /v0/me/rooms')[0]?.body).toEqual({
      name: 'apireview',
      display_name: 'API Review',
      discoverable: true,
    })
  })

  it('closing a ?new=1 dialog drops the parameter', async () => {
    renderApp('/app/rooms?new=1', hub())
    const dialog = await screen().findByRole('dialog', { name: '新建房间' })
    await user().click(within(dialog).getByRole('button', { name: '取消' }))
    await waitFor(() => expect(window.location.search).toBe(''))
    expect(screen().queryByRole('dialog')).toBeNull()
  })
})
