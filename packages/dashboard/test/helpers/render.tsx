/** Testing Library wrappers: render inside the app providers; queries bound to the current body. */
import './dom'
import { afterEach } from 'bun:test'
import { cleanup, type RenderResult, render, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ReactElement } from 'react'
import { Providers } from '../../src/providers'
import { installDom } from './dom'

export { act, fireEvent, waitFor } from '@testing-library/react'

/** DOM lifecycle plus Testing Library cleanup (its auto-cleanup only hooks the first file). */
export function setupUi(): void {
  installDom()
  afterEach(() => cleanup())
}

export function renderUi(ui: ReactElement): RenderResult {
  return render(<Providers>{ui}</Providers>)
}

/** `screen` for the current document (Testing Library's own binds to the first one it saw). */
export function screen(): ReturnType<typeof within> {
  return within(document.body)
}

/** user-event bound to the current document (its default is captured when the module loads). */
export function user(): ReturnType<typeof userEvent.setup> {
  return userEvent.setup({ document })
}
