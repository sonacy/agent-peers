/**
 * Root component: providers and routes (DASHBOARD §2). Member screens live under `/app` inside the
 * signed-in shell; the same bundle mounted at `/admin` is the operator view (§10).
 */
import type { QueryClient } from '@tanstack/react-query'
import { lazy, type ReactNode, Suspense } from 'react'
import { Route, Router, Switch } from 'wouter'
import type { ApiClient } from './api/client'
import { AppShell } from './components/shell/app-shell'
import { CardSkeleton, DelayedSkeleton } from './components/ui/skeleton'
import type { CreateEventSource } from './live/stream'
import { Providers } from './providers'
import HomePage from './routes/home/home-page'
import { PATHS } from './routes/paths'
import { NotFound } from './routes/placeholder'

export const APP_BASE = '/app'
export const ADMIN_BASE = '/admin'

export type AppMode = 'member' | 'operator'

/** Which app a path belongs to: `/admin…` is the operator view, anything else the member app. */
export function modeFor(pathname: string): { readonly mode: AppMode; readonly base: string } {
  return pathname === ADMIN_BASE || pathname.startsWith(`${ADMIN_BASE}/`)
    ? { mode: 'operator', base: ADMIN_BASE }
    : { mode: 'member', base: APP_BASE }
}

const Gallery = lazy(() => import('./routes/gallery/gallery'))
const LoginPage = lazy(() => import('./routes/login/login-page'))
const AsksPage = lazy(() => import('./routes/asks/asks-page'))
const RoomsPage = lazy(() => import('./routes/rooms/rooms-page'))
const RoomDetailPage = lazy(() => import('./routes/rooms/room-detail-page'))
const OperatorApp = lazy(() => import('./routes/operator/operator-app'))

function PageFallback() {
  return (
    <div className="mx-auto w-full max-w-5xl p-4">
      <DelayedSkeleton loading fallback={<CardSkeleton />} />
    </div>
  )
}

function Lazy({ children }: { readonly children: ReactNode }) {
  return <Suspense fallback={<PageFallback />}>{children}</Suspense>
}

function MemberScreens() {
  return (
    <AppShell>
      <Lazy>
        <Switch>
          <Route path={PATHS.home} component={HomePage} />
          <Route path={PATHS.rooms} component={RoomsPage} />
          <Route path="/rooms/:id" component={RoomDetailPage} />
          <Route path={PATHS.asks} component={AsksPage} />
          <Route component={NotFound} />
        </Switch>
      </Lazy>
    </AppShell>
  )
}

export function AppRoutes() {
  return (
    <Lazy>
      <Switch>
        <Route path={PATHS.login} component={LoginPage} />
        <Route path={PATHS.gallery} component={Gallery} />
        <Route>
          <MemberScreens />
        </Route>
      </Switch>
    </Lazy>
  )
}

export interface AppProps {
  readonly base?: string
  readonly mode?: AppMode
  readonly client?: QueryClient
  readonly api?: ApiClient
  readonly createEventSource?: CreateEventSource
}

export function App({ base = APP_BASE, mode = 'member', client, api, createEventSource }: AppProps) {
  return (
    <Providers client={client} api={api} createEventSource={createEventSource}>
      <Router base={base}>
        {mode === 'operator' ? (
          <Lazy>
            <OperatorApp />
          </Lazy>
        ) : (
          <AppRoutes />
        )}
      </Router>
    </Providers>
  )
}
