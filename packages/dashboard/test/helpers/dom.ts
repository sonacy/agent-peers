/**
 * Per-file happy-dom setup (not a global preload, so other packages' tests keep Bun's own globals).
 *
 * Import this module FIRST in a UI test file (as a bare `import '../helpers/dom'`) and call
 * `installDom()`: the import registers a DOM before React DOM, Radix and motion evaluate (they probe
 * `document` at load time), and `installDom()` re-registers for later files and unregisters after each
 * file so happy-dom's `fetch`, `Response` etc. never leak into other tests.
 */

import { afterAll, beforeAll } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'

const OPTIONS = { url: 'http://localhost/app/', width: 1280, height: 800 }

/**
 * wouter patches `history.pushState/replaceState` to emit events once, when it first loads. Each
 * test file gets a fresh happy-dom window, so later files re-apply the same patch here.
 */
const patchedHistories = new WeakSet<History>()

function patchHistoryEvents(): void {
  if (patchedHistories.has(history)) return
  patchedHistories.add(history)
  for (const type of ['pushState', 'replaceState'] as const) {
    const original = history[type]
    history[type] = function patched(this: History, ...args: Parameters<History['pushState']>) {
      const result = original.apply(this, args)
      dispatchEvent(new Event(type))
      return result
    }
  }
}

export function registerDom(): void {
  if (!GlobalRegistrator.isRegistered) {
    GlobalRegistrator.register(OPTIONS)
    patchHistoryEvents()
  }
}

registerDom()

export function installDom(): void {
  beforeAll(registerDom)
  afterAll(async () => {
    // Let React's scheduler finish work queued by the last unmount: it reads `window.event`.
    await new Promise((resolve) => setTimeout(resolve, 25))
    if (GlobalRegistrator.isRegistered) await GlobalRegistrator.unregister()
  })
}
