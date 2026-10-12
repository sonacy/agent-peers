/** Renders the whole member app against a fake hub and fake EventSource. Import after `./render`. */
import { render } from '@testing-library/react'
import { createApiClient } from '../../src/api/client'
import { App } from '../../src/app'
import { REDUCE_MOTION_KEY } from '../../src/lib/motion-preference'
import { createQueryClient } from '../../src/providers'
import { createFakeHub, createFakeSource, FakeEventSource, type FakeHub, type Handler } from './fake-hub'
import { ME } from './fixtures'

/** The default signed-in hub: me, no agents, no rooms, no asks. Override any route. */
export function memberHub(routes: Record<string, Handler> = {}): FakeHub {
  return createFakeHub({
    'GET /v0/me': ME,
    'GET /v0/me/sessions': { sessions: [] },
    'GET /v0/me/rooms': { rooms: [] },
    'GET /v0/me/asks': { asks: [], next_cursor: null },
    ...routes,
  })
}

export function renderApp(path: string, hub: FakeHub) {
  // Reduced motion keeps motion from starting Web Animations that happy-dom cancels on teardown.
  localStorage.setItem(REDUCE_MOTION_KEY, 'true')
  window.history.replaceState(null, '', path)
  FakeEventSource.reset()
  const client = createQueryClient()
  const api = createApiClient({ fetch: hub.fetch })
  const result = render(<App client={client} api={api} createEventSource={createFakeSource} />)
  return { ...result, client }
}
