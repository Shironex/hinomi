import { screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  deploymentDetail,
  findingDetail,
  findingItem,
  findingsResponse,
  mockViews,
  repoRef,
} from '@/test/fixtures'
import { renderApp } from '@/test/render-app'
import { wideScreen } from '@/test/screen'

afterEach(() => vi.unstubAllGlobals())

const MARKER = 'Fixed on main, not released yet'

const released = (id: number, over: Partial<ReturnType<typeof findingItem>> = {}) =>
  findingItem({
    id,
    tier: 'released',
    releaseTag: 'v2.3.0',
    deployments: [],
    repo: repoRef({ id: 24, name: 'kestrel-desk' }),
    factors: { severity: 'high', runtime: true, deployed: false, public: false },
    ...over,
  })

describe('fixed on main marker', () => {
  it('labels the row in All alerts in words, and leaves other rows alone', async () => {
    wideScreen()
    const waiting = released(4, { fixedOnDefaultBranch: true })
    const plain = released(5, { fixedOnDefaultBranch: false })
    mockViews({
      'GET /findings': findingsResponse([waiting, plain], {
        group: 'tier',
        groups: [{ key: 'released', label: 'Released desktop apps', count: 2 }],
      }),
      'GET /findings/4': findingDetail({
        tier: 'released',
        releaseTag: 'v2.3.0',
        fixedOnDefaultBranch: true,
      }),
    })
    await renderApp('/alerts')
    // The finding that main fixed says so in words; the other keeps the plain "Open".
    expect((await screen.findAllByText(MARKER)).length).toBeGreaterThan(0)
    expect(screen.getAllByText('Open').length).toBeGreaterThan(0)
  })

  it('labels the row on a deployment page with a badge and the tag', async () => {
    mockViews({
      'GET /deployments/1': deploymentDetail({
        // The page lists its exposed findings; the row reads the same whatever the tier.
        findings: [released(4, { fixedOnDefaultBranch: true, tier: 'exposed' })],
      }),
    })
    await renderApp('/deployments/1')
    const badge = await screen.findByText(MARKER)
    expect(badge.closest('[data-slot="badge"]')).toBeInTheDocument()
    expect(screen.getByText('in v2.3.0')).toBeInTheDocument()
  })

  it('explains it on the finding page and links the release panel', async () => {
    wideScreen()
    const item = released(4, { fixedOnDefaultBranch: true })
    mockViews({
      'GET /findings/4': findingDetail({
        tier: item.tier,
        releaseTag: item.releaseTag,
        fixedOnDefaultBranch: item.fixedOnDefaultBranch,
        repo: item.repo,
        deployments: [],
      }),
    })
    await renderApp('/finding/4')
    const heading = await screen.findByRole('heading', { name: MARKER })
    const box = within(heading.closest('section') as HTMLElement)
    expect(box.getByText(/It stays open because users still run that build/)).toBeInTheDocument()
    expect(
      box.getByRole('link', { name: /Release panel for kestrel-co\/kestrel-desk/ }),
    ).toHaveAttribute('href', '/repos/24')
  })

  it('says a release finding is in the released build when main has not fixed it', async () => {
    wideScreen()
    mockViews({
      'GET /findings/5': findingDetail({
        tier: 'released',
        releaseTag: 'v2.3.0',
        repo: repoRef({ id: 24, name: 'kestrel-desk' }),
        deployments: [],
      }),
    })
    await renderApp('/finding/5')
    expect(
      await screen.findByRole('heading', { name: 'In the released build v2.3.0' }),
    ).toBeInTheDocument()
    expect(screen.queryByText(MARKER)).not.toBeInTheDocument()
  })
})
