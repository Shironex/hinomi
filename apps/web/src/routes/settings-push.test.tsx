import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { channel, configuredRoutes, mockApi, reply } from '@/test/mock-api'
import { renderApp } from '@/test/render-app'

// The "This browser" channel. The browser's push API is replaced: jsdom has none.

const push = vi.hoisted(() => ({
  problem: null as string | null,
  subscribe: vi.fn(),
}))
vi.mock('@/lib/web-push', () => ({
  webPushProblem: () => push.problem,
  subscribeThisBrowser: push.subscribe,
}))

const PUBLIC_KEY = 'BFictionalVapidPublicKey'
const browserChannel = {
  ...channel,
  id: '9d4e2b1a-6c3f-4a8e-b7d0-2e1f3a4b5c6d',
  kind: 'webpush',
  name: 'Work laptop',
  url: 'https://push.example.dev/…a1b2',
  secretSet: true,
}

async function openBrowserKind(user: ReturnType<typeof userEvent.setup>) {
  await renderApp('/settings?sel=notifications')
  const region = within(await screen.findByRole('region', { name: 'Notification channels' }))
  await user.click(await region.findByRole('button', { name: 'Add channel' }))
  await user.click(region.getByRole('radio', { name: 'This browser' }))
  return region
}

describe('browser push channel in settings', () => {
  afterEach(() => {
    push.problem = null
    push.subscribe.mockReset()
  })

  it('subscribes this browser with the server key and adds it', async () => {
    push.subscribe.mockResolvedValue({ url: 'https://push.example.dev/abc', secret: 'p.a' })
    const api = mockApi({
      ...configuredRoutes(),
      'GET /notifications/channels': { items: [] },
      'GET /notifications/push-key': { publicKey: PUBLIC_KEY },
      'POST /notifications/channels': reply(201, browserChannel),
    })
    const user = userEvent.setup()
    const region = await openBrowserKind(user)
    expect(region.queryByLabelText(/URL|token/i)).not.toBeInTheDocument()
    await user.type(region.getByLabelText('Name'), 'Work laptop')
    await user.click(region.getByRole('button', { name: 'Add channel' }))
    await waitFor(() => expect(api.called('POST', '/notifications/channels')).toHaveLength(1))
    expect(push.subscribe).toHaveBeenCalledWith(PUBLIC_KEY)
    expect(api.called('POST', '/notifications/channels')[0]?.body).toEqual({
      kind: 'webpush',
      name: 'Work laptop',
      minSeverity: 'high',
      url: 'https://push.example.dev/abc',
      secret: 'p.a',
    })
  })

  it('says why it cannot work here and does not offer to add', async () => {
    push.problem = 'This browser does not support push notifications.'
    mockApi({ ...configuredRoutes(), 'GET /notifications/channels': { items: [] } })
    const user = userEvent.setup()
    const region = await openBrowserKind(user)
    expect(region.getByText(push.problem)).toBeInTheDocument()
    expect(region.getByRole('button', { name: 'Add channel' })).toBeDisabled()
  })

  it('shows a refused permission as the error', async () => {
    push.subscribe.mockRejectedValue(
      new Error('Notifications were not allowed, so this browser cannot be added.'),
    )
    mockApi({
      ...configuredRoutes(),
      'GET /notifications/channels': { items: [] },
      'GET /notifications/push-key': { publicKey: PUBLIC_KEY },
    })
    const user = userEvent.setup()
    const region = await openBrowserKind(user)
    await user.click(region.getByRole('button', { name: 'Add channel' }))
    expect(await region.findByRole('alert')).toHaveTextContent(/were not allowed/)
  })
})

describe('a browser channel Hinomi turned off', () => {
  it('shows why', async () => {
    mockApi({
      ...configuredRoutes(),
      'GET /notifications/channels': {
        items: [
          {
            ...browserChannel,
            enabled: false,
            disabledReason:
              'The web push key changed because HINOMI_SECRET_KEY changed. Remove this channel and add the browser again.',
          },
        ],
      },
    })
    await renderApp('/settings?sel=notifications')
    const region = within(await screen.findByRole('region', { name: 'Notification channels' }))
    expect(await region.findByText(/web push key changed/)).toBeInTheDocument()
  })
})
