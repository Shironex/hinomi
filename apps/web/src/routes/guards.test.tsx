import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  apiError,
  findingGuard,
  findingsResponse,
  guardDetail,
  guardItem,
  mockViews,
  overview,
  repoRef,
} from '@/test/fixtures'
import { reply } from '@/test/mock-api'
import { renderApp } from '@/test/render-app'

afterEach(() => vi.unstubAllGlobals())

const override = {
  id: 4,
  scope: 'deployment' as const,
  reason: 'Vendor image needs root for port 80',
  createdAt: '2026-11-02T10:00:00.000Z',
}

describe('guards view', () => {
  it('lists guard findings with their level and the Guard chip, filtered on kind guard', async () => {
    const api = mockViews({
      'GET /findings': findingsResponse([guardItem()], {
        group: 'tier',
        groups: [{ key: 'exposed', label: 'Exposed on a public app', count: 1 }],
      }),
      'GET /findings/30': guardDetail(),
      'GET /overview': overview(),
    })
    await renderApp('/guards')
    const row = await screen.findByRole('link', { name: /storefront-web/ })
    expect(within(row).getByText('Fail')).toBeInTheDocument()
    expect(within(row).getByText('Guard')).toBeInTheDocument()
    expect(within(row).getByText('Container runs as root')).toBeInTheDocument()
    expect(within(row).getByText('User root, from Dockerfile line 31')).toBeInTheDocument()
    expect(screen.getByText('Tier 1: Exposed on a public app')).toBeInTheDocument()
    const search = api.called('GET', '/findings')[0]?.search
    expect(search?.get('kind')).toBe('guard')
    expect(search?.get('group')).toBe('tier')
  })

  it('turns the level chips and the check select into query params', async () => {
    const api = mockViews({
      'GET /findings': findingsResponse([guardItem()]),
      'GET /findings/30': guardDetail(),
      'GET /overview': overview(),
    })
    const user = userEvent.setup()
    const { router } = await renderApp('/guards')
    await screen.findByRole('link', { name: /storefront-web/ })

    await user.click(screen.getByRole('button', { name: 'Unknown' }))
    await waitFor(() =>
      expect(api.called('GET', '/findings').at(-1)?.search.get('level')).toBe('fail,warn'),
    )
    expect(router.state.location.search).toMatchObject({ level: ['fail', 'warn'] })

    await user.selectOptions(screen.getByLabelText('Check'), 'Docker socket mounted')
    await waitFor(() =>
      expect(api.called('GET', '/findings').at(-1)?.search.get('check')).toBe('docker_socket'),
    )
  })

  it('says what guards are when there is no guard finding, and /drift lands here', async () => {
    mockViews({ 'GET /findings': findingsResponse([]), 'GET /overview': overview() })
    const { router } = await renderApp('/drift')
    expect(await screen.findByRole('heading', { name: 'No guard findings' })).toBeInTheDocument()
    expect(router.state.location.pathname).toBe('/guards')
    expect(screen.getByRole('link', { name: 'See the checks' })).toHaveAttribute(
      'href',
      '/settings?sel=checks',
    )
  })
})

describe('guard finding detail', () => {
  it('shows the level, why it matters, what Hinomi read and the fix', async () => {
    mockViews({ 'GET /findings/30': guardDetail() })
    await renderApp('/finding/30')
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Container runs as root' }),
    ).toBeInTheDocument()
    expect(screen.getByText('counts as high')).toBeInTheDocument()
    expect(screen.getByText('Fail, counts as high')).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Why it matters' })).toBeInTheDocument()
    expect(screen.getByText(/A bug in the app or a dependency gets root/)).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'What Hinomi read' })).toBeInTheDocument()
    expect(screen.getByText('Dockerfile:31')).toBeInTheDocument()
    expect(screen.getByText('node:22-bookworm-slim')).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'How to fix it' })).toBeInTheDocument()
    expect(screen.getByText('USER app')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Turn off' })).toBeInTheDocument()
  })

  it('turns the check off for the repo with a required reason', async () => {
    const api = mockViews({
      'GET /findings/30': guardDetail(),
      'POST /overrides': reply(201, {
        id: 9,
        check: 'root_user',
        deployment: null,
        repo: repoRef(),
        reason: 'Internal tooling image',
        createdAt: '2026-11-05T10:00:00.000Z',
        updatedAt: '2026-11-05T10:00:00.000Z',
      }),
    })
    const user = userEvent.setup()
    await renderApp('/finding/30')
    await user.click(await screen.findByRole('button', { name: 'Turn off' }))

    const dialog = await screen.findByRole('dialog', { name: 'Turn off: Container runs as root' })
    expect(within(dialog).getByText(/The check keeps running on every scan/)).toBeInTheDocument()
    expect(within(dialog).getByText(/stays listed under Risk accepted/)).toBeInTheDocument()
    const reason = within(dialog).getByLabelText('Reason')
    await waitFor(() => expect(reason).toHaveFocus())
    expect(
      within(dialog).getByRole('radio', { name: /This deployment, storefront-web/ }),
    ).toBeChecked()

    await user.click(within(dialog).getByRole('button', { name: 'Turn off' }))
    expect(within(dialog).getByText('Add a reason so the next person knows why.')).toBeVisible()
    expect(api.called('POST', '/overrides')).toHaveLength(0)

    await user.click(
      within(dialog).getByRole('radio', { name: /The whole repo, kestrel-co\/storefront/ }),
    )
    await user.type(reason, 'Internal tooling image')
    await user.click(within(dialog).getByRole('button', { name: 'Turn off' }))
    await waitFor(() =>
      expect(api.called('POST', '/overrides')[0]?.body).toEqual({
        check: 'root_user',
        repoId: 1,
        reason: 'Internal tooling image',
      }),
    )
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
  })

  it('keeps the dialog open with the error when the server refuses', async () => {
    mockViews({
      'GET /findings/30': guardDetail(),
      'POST /overrides': apiError(409, 'conflict', 'The check is already off for it'),
    })
    const user = userEvent.setup()
    await renderApp('/finding/30')
    await user.click(await screen.findByRole('button', { name: 'Turn off' }))
    const dialog = await screen.findByRole('dialog')
    await user.type(within(dialog).getByLabelText('Reason'), 'Known')
    await user.click(within(dialog).getByRole('button', { name: 'Turn off' }))
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      'The check is already off for it',
    )
  })

  it('shows a turned off check as accepted with its reason, and edits or removes the override', async () => {
    const turnedOff = guardDetail({
      state: 'accepted',
      stateReason: override.reason,
      guard: findingGuard({ override }),
    })
    const api = mockViews({
      'GET /findings/30': turnedOff,
      'PATCH /overrides/4': {
        id: 4,
        check: 'root_user',
        deployment: null,
        repo: null,
        reason: 'Vendor image, internal only',
        createdAt: override.createdAt,
        updatedAt: '2026-11-05T10:00:00.000Z',
      },
      'DELETE /overrides/4': reply(204),
    })
    const user = userEvent.setup()
    await renderApp('/finding/30')
    expect(
      await screen.findByText('Turned off for this deployment, 2 Nov 2026'),
    ).toBeInTheDocument()
    expect(screen.getAllByText(override.reason).length).toBeGreaterThan(0)
    expect(screen.queryByRole('button', { name: 'Snooze' })).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Edit reason or turn back on' }))
    let dialog = await screen.findByRole('dialog', { name: 'Turned off with a reason' })
    const reason = within(dialog).getByLabelText('Reason')
    expect(reason).toHaveValue(override.reason)
    await user.clear(reason)
    await user.type(reason, 'Vendor image, internal only')
    await user.click(within(dialog).getByRole('button', { name: 'Save reason' }))
    await waitFor(() =>
      expect(api.called('PATCH', '/overrides/4')[0]?.body).toEqual({
        reason: 'Vendor image, internal only',
      }),
    )
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())

    await user.click(screen.getByRole('button', { name: 'Turned off, edit' }))
    dialog = await screen.findByRole('dialog')
    await user.click(within(dialog).getByRole('button', { name: 'Turn the check back on' }))
    await waitFor(() => expect(api.called('DELETE', '/overrides/4')).toHaveLength(1))
  })

  it('offers only the repo for a repo check', async () => {
    mockViews({
      'GET /findings/30': guardDetail({
        guard: findingGuard({
          check: 'runtime_pins_disagree',
          level: 'warn',
          evidence: { check: 'runtime_pins_disagree', ref: 'main', runtimes: [], reason: null },
        }),
      }),
    })
    const user = userEvent.setup()
    await renderApp('/finding/30')
    await user.click(await screen.findByRole('button', { name: 'Turn off' }))
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).queryByRole('radio')).not.toBeInTheDocument()
    expect(within(dialog).getByText('The whole repo, kestrel-co/storefront')).toBeInTheDocument()
  })
})
