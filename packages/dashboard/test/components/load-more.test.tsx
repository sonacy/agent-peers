import '../helpers/dom'
import { describe, expect, it, mock } from 'bun:test'
import { LoadMore } from '../../src/routes/asks/load-more'
import { renderUi, screen, setupUi } from '../helpers/render'

setupUi()

describe('LoadMore', () => {
  it('loads when the sentinel scrolls into view and disconnects on unmount', () => {
    const observed: Element[] = []
    let callback: ((entries: { isIntersecting: boolean }[]) => void) | undefined
    const disconnect = mock(() => {})
    const original = globalThis.IntersectionObserver
    globalThis.IntersectionObserver = class {
      constructor(cb: (entries: { isIntersecting: boolean }[]) => void) {
        callback = cb
      }
      observe(el: Element) {
        observed.push(el)
      }
      disconnect = disconnect
    } as unknown as typeof IntersectionObserver
    const onLoad = mock(() => {})
    const view = renderUi(<LoadMore hasMore loading={false} onLoad={onLoad} shown={3} />)
    expect(observed).toHaveLength(1)
    callback?.([{ isIntersecting: false }])
    expect(onLoad).not.toHaveBeenCalled()
    callback?.([{ isIntersecting: true }])
    expect(onLoad).toHaveBeenCalledTimes(1)
    view.unmount()
    expect(disconnect).toHaveBeenCalled()
    globalThis.IntersectionObserver = original
  })
  it('shows a retry note after a failed page and the total at the end', () => {
    renderUi(<LoadMore hasMore loading failed onLoad={() => {}} shown={3} />)
    expect(screen().getByRole('alert').textContent).toContain('下一页没加载出来')
    expect(screen().getByRole('button', { name: '正在加载…' }).hasAttribute('disabled')).toBe(true)
  })
})
