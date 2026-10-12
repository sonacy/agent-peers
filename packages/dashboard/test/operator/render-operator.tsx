/** Renders the operator view over a fake admin API. Import after `../helpers/dom`. */
import { render } from '@testing-library/react'
import { Router } from 'wouter'
import { REDUCE_MOTION_KEY } from '../../src/lib/motion-preference'
import { createQueryClient, Providers } from '../../src/providers'
import { createAdminClient } from '../../src/routes/operator/admin-api'
import OperatorApp from '../../src/routes/operator/operator-app'
import type { FakeHub } from '../helpers/fake-hub'

export function renderOperator(hub: FakeHub) {
  localStorage.setItem(REDUCE_MOTION_KEY, 'true')
  window.history.replaceState(null, '', '/admin/')
  const client = createQueryClient()
  const api = createAdminClient({ fetch: hub.fetch })
  const result = render(
    <Providers client={client}>
      <Router base="/admin">
        <OperatorApp api={api} />
      </Router>
    </Providers>,
  )
  return { ...result, client }
}
