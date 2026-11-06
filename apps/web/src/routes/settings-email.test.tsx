import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { channel, configuredRoutes, mockApi, reply } from '@/test/mock-api'
import { renderApp } from '@/test/render-app'

const emailChannel = {
  ...channel,
  id: '7c1a2f4e-5b0d-4c6e-9a3b-2d8e1f0a4b5c',
  kind: 'email',
  name: 'Ops mailbox',
  url: 'smtp.example.dev:587',
  urlEncrypted: true,
  email: {
    host: 'smtp.example.dev',
    port: 587,
    security: 'starttls',
    user: 'hinomi@example.dev',
    from: 'hinomi@example.dev',
    to: ['ops@example.dev'],
    passwordSet: true,
  },
}

/** Fills a long value in one paste: typing it key by key costs seconds under a busy machine. */
async function fill(user: ReturnType<typeof userEvent.setup>, field: HTMLElement, text: string) {
  await user.click(field)
  await user.paste(text)
}

async function notificationsRegion() {
  return within(await screen.findByRole('region', { name: 'Notifications' }))
}

describe('email channels in settings', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('adds an email channel with inline validation', async () => {
    let channels: unknown[] = []
    const api = mockApi({
      ...configuredRoutes(),
      'GET /notifications/channels': () => ({ items: channels }),
      'POST /notifications/channels': () => {
        channels = [emailChannel]
        return reply(201, emailChannel)
      },
    })
    const user = userEvent.setup()
    await renderApp('/settings')
    const region = await notificationsRegion()
    await user.click(await region.findByRole('button', { name: 'Add channel' }))
    await user.click(region.getByRole('radio', { name: 'Email' }))
    await user.click(region.getByRole('button', { name: 'Add channel' }))

    expect(region.getByLabelText('SMTP host')).toHaveAccessibleDescription(/Enter the SMTP host\./)
    expect(region.getByLabelText('From')).toHaveAttribute('aria-invalid', 'true')
    expect(region.getByLabelText('Send to')).toHaveAccessibleDescription(/at least one address/)
    expect(api.called('POST', '/notifications/channels')).toHaveLength(0)

    await fill(user, region.getByLabelText('SMTP host'), 'smtp.example.dev')
    await fill(user, region.getByLabelText('User'), 'hinomi@example.dev')
    await fill(user, region.getByLabelText('Password'), 'smtp-pass')
    await fill(user, region.getByLabelText('From'), 'hinomi@example.dev')
    await fill(user, region.getByLabelText('Send to'), 'ops@example.dev, oncall@example.dev')
    await user.click(region.getByRole('button', { name: 'Add channel' }))

    expect(await region.findByRole('heading', { name: 'Ops mailbox' })).toBeInTheDocument()
    expect(api.called('POST', '/notifications/channels')[0]?.body).toEqual({
      kind: 'email',
      name: 'Email',
      email: {
        host: 'smtp.example.dev',
        port: 587,
        security: 'starttls',
        user: 'hinomi@example.dev',
        password: 'smtp-pass',
        from: 'hinomi@example.dev',
        to: ['ops@example.dev', 'oncall@example.dev'],
      },
      minSeverity: 'high',
    })
  })

  it('follows the security mode with the default port until the port is typed', async () => {
    mockApi({ ...configuredRoutes(), 'GET /notifications/channels': { items: [] } })
    const user = userEvent.setup()
    await renderApp('/settings')
    const region = await notificationsRegion()
    await user.click(await region.findByRole('button', { name: 'Add channel' }))
    await user.click(region.getByRole('radio', { name: 'Email' }))
    await user.selectOptions(region.getByLabelText('Connection security'), 'tls')
    expect(region.getByLabelText('Port')).toHaveValue('465')
    await user.clear(region.getByLabelText('Port'))
    await user.type(region.getByLabelText('Port'), '2525')
    await user.selectOptions(region.getByLabelText('Connection security'), 'none')
    expect(region.getByLabelText('Port')).toHaveValue('2525')
  })

  it('edits without resending the password and sends only what changed', async () => {
    const api = mockApi({
      ...configuredRoutes(),
      'GET /notifications/channels': { items: [emailChannel] },
      [`PATCH /notifications/channels/${emailChannel.id}`]: emailChannel,
    })
    const user = userEvent.setup()
    await renderApp('/settings')
    const region = await notificationsRegion()
    expect(await region.findByText('smtp.example.dev:587')).toBeInTheDocument()
    await user.click(region.getByRole('button', { name: /edit/i }))
    expect(region.getByLabelText('Password')).toHaveValue('')
    expect(region.getByText('A password is set. Leave empty to keep it.')).toBeInTheDocument()
    await user.clear(region.getByLabelText('Send to'))
    await user.type(region.getByLabelText('Send to'), 'ops@example.dev, oncall@example.dev')
    await user.click(region.getByRole('button', { name: 'Save changes' }))
    await waitFor(() =>
      expect(api.called('PATCH', `/notifications/channels/${emailChannel.id}`)).toHaveLength(1),
    )
    expect(api.called('PATCH', `/notifications/channels/${emailChannel.id}`)[0]?.body).toEqual({
      email: { to: ['ops@example.dev', 'oncall@example.dev'] },
    })
  })
})
