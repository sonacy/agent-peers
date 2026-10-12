import '../helpers/dom'
import { describe, expect, it } from 'bun:test'
import { loginCodeFrom } from '../../src/routes/login/login-page'
import { memberHub, renderApp } from '../helpers/app'
import { apiError } from '../helpers/fake-hub'
import { screen, setupUi, user, waitFor } from '../helpers/render'

setupUi()

describe('login', () => {
  it('reads the one-time code from ?c= or ?code=', () => {
    expect(loginCodeFrom('?c=abc')).toBe('abc')
    expect(loginCodeFrom('code=xyz')).toBe('xyz')
    expect(loginCodeFrom('')).toBeUndefined()
    expect(loginCodeFrom(`?c=${'x'.repeat(129)}`)).toBeUndefined()
  })
  it('explains how to sign in without a code', async () => {
    renderApp('/app/login', memberHub())
    expect(await screen().findByRole('heading', { name: '还没登录' })).toBeDefined()
    expect(screen().getByText('/peers:dashboard')).toBeDefined()
    expect(screen().queryByRole('button', { name: '继续' })).toBeNull()
  })
  it('says signed out after logout', async () => {
    renderApp('/app/login?signed_out=1', memberHub())
    expect(await screen().findByRole('heading', { name: '已退出登录' })).toBeDefined()
  })
  it('posts the code on Continue and goes home', async () => {
    const hub = memberHub({ 'POST /app/login': { ok: true } })
    renderApp('/app/login?c=one-time', hub)
    await user().click(await screen().findByRole('button', { name: '继续' }))
    await waitFor(() => expect(hub.callsTo('POST /app/login')[0]?.body).toEqual({ code: 'one-time' }))
    expect(await screen().findByRole('heading', { name: '嗨，gulei 👋' }, { timeout: 3000 })).toBeDefined()
  })
  it('explains an expired or used link', async () => {
    const hub = memberHub({ 'POST /app/login': () => apiError('unauthorized', 401) })
    renderApp('/app/login?c=used', hub)
    await user().click(await screen().findByRole('button', { name: '继续' }))
    expect(await screen().findByText(/已经用过或过期了/)).toBeDefined()
  })
  it('shows other failures in plain words', async () => {
    const hub = memberHub({ 'POST /app/login': () => apiError('rate_limited', 429, 'slow', 2000) })
    renderApp('/app/login?c=x', hub)
    await user().click(await screen().findByRole('button', { name: '继续' }))
    expect(await screen().findByText('操作太快了，2 秒后再试。')).toBeDefined()
  })
})
