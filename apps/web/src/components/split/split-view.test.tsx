import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import {
  createMemoryHistory,
  createRootRouteWithContext,
  createRoute,
  createRouter,
} from '@tanstack/react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { App } from '@/App'
import { AppShell } from '@/components/shell/app-shell'
import { createQueryClient } from '@/lib/queries'
import type { RouterContext } from '@/router'
import { splitSearchSchema } from '@/lib/split-search'
import { configuredRoutes, mockApi } from '@/test/mock-api'
import { SplitListHeader } from './split-parts'
import { SplitView } from './split-view'

interface Pkg {
  id: number
  name: string
  public: boolean
}

const PKGS: Pkg[] = [
  { id: 11, name: 'tessera', public: true },
  { id: 12, name: 'authline', public: true },
  { id: 13, name: 'yamlette', public: false },
]

const actions = { fix: vi.fn<(p: Pkg) => void>(), snooze: vi.fn<(p: Pkg) => void>() }

function Triage() {
  return (
    <SplitView
      items={PKGS}
      getKey={(p) => p.id}
      getLabel={(p) => p.name}
      listLabel="Packages"
      listHeader={<SplitListHeader title="Triage" meta="3 open" />}
      getGroup={(p) =>
        p.public ? { key: 'pub', label: 'Public' } : { key: 'int', label: 'Internal' }
      }
      renderRow={(p) => <span>{p.name} row</span>}
      renderDetail={(p, { focused }) => (
        <h2>
          {p.name} detail{focused ? ', focused' : ''}
        </h2>
      )}
      actions={actions}
    />
  )
}

async function renderSplit(path: string) {
  const rootRoute = createRootRouteWithContext<RouterContext>()({ component: AppShell })
  const triage = createRoute({
    getParentRoute: () => rootRoute,
    path: '/triage',
    component: Triage,
    validateSearch: splitSearchSchema,
    staticData: { nav: 'overview', crumb: 'Triage', layout: 'split' },
  })
  const queryClient = createQueryClient()
  queryClient.setDefaultOptions({ queries: { retry: false } })
  const router = createRouter({
    routeTree: rootRoute.addChildren([triage]),
    context: { queryClient },
    history: createMemoryHistory({ initialEntries: [path] }),
  })
  await router.load()
  // The test tree is not the registered one; App only needs a router to provide.
  render(<App queryClient={queryClient} router={router as never} />)
  return { router }
}

/** The test setup answers every media query with false; this makes width queries match. */
function screenWidth(wide: boolean) {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: wide && query.includes('min-width'),
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  }))
}

describe('SplitView', () => {
  beforeEach(() => screenWidth(true))
  afterEach(() => {
    vi.unstubAllGlobals()
    actions.fix.mockReset()
    actions.snooze.mockReset()
  })

  it('shows the first item beside the list, with the top bar and key hints in the detail pane', async () => {
    mockApi(configuredRoutes())
    await renderSplit('/triage')
    expect(await screen.findByRole('heading', { level: 1, name: 'Triage' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { level: 2, name: 'tessera detail' })).toBeInTheDocument()
    const list = screen.getByRole('list', { name: 'Packages' })
    expect(within(list).getByRole('link', { name: 'tessera row' })).toHaveAttribute(
      'aria-current',
      'true',
    )
    expect(within(list).getByText('Internal')).toBeInTheDocument()
    const crumbs = screen.getByRole('navigation', { name: 'Breadcrumb' })
    expect(within(crumbs).getByText('tessera')).toHaveAttribute('aria-current', 'page')
    expect(screen.getByText('fix agent')).toBeInTheDocument()
    expect(screen.queryByText('accept')).not.toBeInTheDocument()
  })

  it('keeps the selection in the URL and moves it with j and k', async () => {
    mockApi(configuredRoutes())
    const user = userEvent.setup()
    const { router } = await renderSplit('/triage?sel=12')
    expect(await screen.findByRole('heading', { name: 'authline detail' })).toBeInTheDocument()

    await user.keyboard('j')
    await waitFor(() => expect(router.state.location.search).toMatchObject({ sel: 13 }))
    expect(await screen.findByRole('heading', { name: 'yamlette detail' })).toBeInTheDocument()
    await waitFor(() => expect(screen.getByRole('link', { name: 'yamlette row' })).toHaveFocus())

    await user.keyboard('j')
    expect(router.state.location.search).toMatchObject({ sel: 13 })
    await user.keyboard('kk')
    await waitFor(() => expect(router.state.location.search).toMatchObject({ sel: 11 }))
  })

  it('selects a row on click', async () => {
    mockApi(configuredRoutes())
    const user = userEvent.setup()
    const { router } = await renderSplit('/triage')
    await user.click(await screen.findByRole('link', { name: 'authline row' }))
    await waitFor(() => expect(router.state.location.search).toMatchObject({ sel: 12 }))
    expect(await screen.findByRole('heading', { name: 'authline detail' })).toBeInTheDocument()
  })

  it('opens the focus view with Enter and leaves it with Esc', async () => {
    mockApi(configuredRoutes())
    const user = userEvent.setup()
    await renderSplit('/triage')
    await screen.findByRole('heading', { name: 'tessera detail' })
    await user.keyboard('{Enter}')
    expect(
      await screen.findByRole('heading', { name: 'tessera detail, focused' }),
    ).toBeInTheDocument()
    expect(screen.queryByRole('list', { name: 'Packages' })).not.toBeInTheDocument()
    expect(screen.getByText('back to list')).toBeInTheDocument()

    await user.keyboard('{Escape}')
    expect(await screen.findByRole('list', { name: 'Packages' })).toBeInTheDocument()
    await waitFor(() => expect(screen.getByRole('link', { name: 'tessera row' })).toHaveFocus())
  })

  it('runs the view actions on the selected item with f and s, and ignores a', async () => {
    mockApi(configuredRoutes())
    const user = userEvent.setup()
    await renderSplit('/triage?sel=13')
    await screen.findByRole('heading', { name: 'yamlette detail' })
    await user.keyboard('fsa')
    expect(actions.fix).toHaveBeenCalledWith(PKGS[2])
    expect(actions.snooze).toHaveBeenCalledWith(PKGS[2])
  })

  it('is list then detail below 1100 px', async () => {
    screenWidth(false)
    mockApi(configuredRoutes())
    const user = userEvent.setup()
    const { router } = await renderSplit('/triage')
    await screen.findByRole('heading', { level: 1, name: 'Triage' })
    expect(screen.queryByRole('heading', { level: 2 })).not.toBeInTheDocument()

    await user.click(screen.getByRole('link', { name: 'authline row' }))
    expect(await screen.findByRole('heading', { name: 'authline detail' })).toBeInTheDocument()
    expect(screen.getByText('#2 of 3')).toBeInTheDocument()
    expect(screen.queryByRole('list', { name: 'Packages' })).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Next' }))
    await waitFor(() => expect(router.state.location.search).toMatchObject({ sel: 13 }))
    expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled()

    await act(() => user.keyboard('{Escape}'))
    expect(await screen.findByRole('list', { name: 'Packages' })).toBeInTheDocument()
    expect(router.state.location.search).not.toHaveProperty('sel')
  })
})
