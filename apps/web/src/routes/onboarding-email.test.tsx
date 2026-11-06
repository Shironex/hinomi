import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { coolifySource, githubSource, mockApi, reply } from '@/test/mock-api'
import { renderApp } from '@/test/render-app'

describe('onboarding alerts step', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('can add an email channel', async () => {
    const api = mockApi({
      'GET /health': { status: 'ok' },
      'GET /shell/nav-counts': {
        needsAction: null,
        deployments: null,
        alerts: null,
        activeFixRuns: null,
      },
      'GET /shell/scan-status': { state: 'unconfigured' },
      'GET /sources': { sources: [coolifySource, githubSource], canStoreTokens: true },
      'GET /notifications/channels': { items: [] },
      'GET /scans': { items: [] },
      'GET /settings': { scanIntervalMinutes: 360, osvEnabled: true, includeAccountRepos: false },
      'POST /notifications/channels': () =>
        reply(201, { id: '7c1a2f4e-5b0d-4c6e-9a3b-2d8e1f0a4b5c' }),
    })
    const user = userEvent.setup()
    await renderApp('/onboarding')
    const step = within(
      (await screen.findByRole('heading', { name: /Where should alerts go/ })).closest('li') ??
        document.body,
    )
    await user.click(await step.findByRole('radio', { name: 'Email' }))
    await user.type(step.getByLabelText('SMTP host'), 'smtp.example.dev')
    await user.type(step.getByLabelText('From'), 'hinomi@example.dev')
    await user.type(step.getByLabelText('Send to'), 'ops@example.dev')
    await user.click(step.getByRole('button', { name: 'Save and continue' }))
    await waitFor(() => expect(api.called('POST', '/notifications/channels')).toHaveLength(1))
    expect(api.called('POST', '/notifications/channels')[0]?.body).toMatchObject({
      kind: 'email',
      email: { host: 'smtp.example.dev', port: 587, security: 'starttls', to: ['ops@example.dev'] },
    })
  })
})
