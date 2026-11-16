import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { channel, configuredRoutes, mockApi, reply } from '@/test/mock-api'
import { renderApp } from '@/test/render-app'

// Slack, Telegram, ntfy and Gotify channels in the settings. Every token is fictional.

// A fake bot token, built from parts so no literal in the source looks like a real one.
const BOT_TOKEN = ['42', `fake_bot_token_${'x'.repeat(10)}`].join(':')

const telegramChannel = {
  ...channel,
  id: '3a7d9c1e-2b4f-4e6a-8c0d-1f2e3a4b5c6d',
  kind: 'telegram',
  name: 'Ops chat',
  url: 'Telegram chat -1001234567890',
  chatId: '-1001234567890',
  secretSet: true,
}

const ntfyChannel = {
  ...channel,
  id: '5c2e8a1f-3d4b-4f6a-9e0c-7b8d9a0e1f2a',
  kind: 'ntfy',
  name: 'Phone',
  url: 'http://ntfy.lan/…',
  allowPrivate: true,
  secretSet: true,
}

async function fill(user: ReturnType<typeof userEvent.setup>, field: HTMLElement, text: string) {
  await user.click(field)
  await user.paste(text)
}

async function openAddForm(user: ReturnType<typeof userEvent.setup>, kind: string) {
  await renderApp('/settings?sel=notifications')
  const region = within(await screen.findByRole('region', { name: 'Notification channels' }))
  await user.click(await region.findByRole('button', { name: 'Add channel' }))
  await user.click(region.getByRole('radio', { name: kind }))
  return region
}

describe('more notification channels in settings', () => {
  it('adds a Telegram channel with a bot token and a checked chat id', async () => {
    let channels: unknown[] = []
    const api = mockApi({
      ...configuredRoutes(),
      'GET /notifications/channels': () => ({ items: channels }),
      'POST /notifications/channels': () => {
        channels = [telegramChannel]
        return reply(201, telegramChannel)
      },
    })
    const user = userEvent.setup()
    const region = await openAddForm(user, 'Telegram')
    expect(region.queryByLabelText(/URL/)).not.toBeInTheDocument()
    await user.click(region.getByRole('button', { name: 'Add channel' }))
    expect(region.getByLabelText('Bot token')).toHaveAccessibleDescription(/Paste the bot token\./)
    expect(region.getByLabelText('Chat id')).toHaveAttribute('aria-invalid', 'true')
    expect(api.called('POST', '/notifications/channels')).toHaveLength(0)

    await fill(user, region.getByLabelText('Bot token'), BOT_TOKEN)
    await fill(user, region.getByLabelText('Chat id'), '-1001234567890')
    await user.click(region.getByRole('button', { name: 'Add channel' }))
    expect(await region.findByRole('heading', { name: 'Ops chat' })).toBeInTheDocument()
    expect(api.called('POST', '/notifications/channels')[0]?.body).toEqual({
      kind: 'telegram',
      name: 'Telegram',
      secret: BOT_TOKEN,
      chatId: '-1001234567890',
      minSeverity: 'high',
    })
  })

  it('adds an ntfy channel on the local network only when private addresses are allowed', async () => {
    const api = mockApi({
      ...configuredRoutes(),
      'GET /notifications/channels': { items: [] },
      'POST /notifications/channels': reply(201, ntfyChannel),
    })
    const user = userEvent.setup()
    const region = await openAddForm(user, 'ntfy')
    await fill(user, region.getByLabelText('Topic URL'), 'http://ntfy.lan/hinomi')
    await user.click(region.getByRole('checkbox', { name: /Allow private addresses/ }))
    await user.click(region.getByRole('button', { name: 'Add channel' }))
    await waitFor(() => expect(api.called('POST', '/notifications/channels')).toHaveLength(1))
    expect(api.called('POST', '/notifications/channels')[0]?.body).toEqual({
      kind: 'ntfy',
      name: 'ntfy',
      url: 'http://ntfy.lan/hinomi',
      allowPrivate: true,
      minSeverity: 'high',
    })
  })

  it('offers no private addresses switch for Slack', async () => {
    mockApi({ ...configuredRoutes(), 'GET /notifications/channels': { items: [] } })
    const user = userEvent.setup()
    const region = await openAddForm(user, 'Slack')
    expect(region.getByLabelText('Slack webhook URL')).toBeInTheDocument()
    expect(region.queryByRole('checkbox')).not.toBeInTheDocument()
    expect(region.queryByLabelText(/token|secret/i)).not.toBeInTheDocument()
  })

  it('puts a refused token by its field', async () => {
    mockApi({
      ...configuredRoutes(),
      'GET /notifications/channels': { items: [] },
      'POST /notifications/channels': reply(400, {
        error: {
          code: 'validation_failed',
          message: 'A Telegram bot token looks like 123456789:AA... (ask @BotFather for it)',
        },
      }),
    })
    const user = userEvent.setup()
    const region = await openAddForm(user, 'Telegram')
    await fill(user, region.getByLabelText('Bot token'), 'not-a-token')
    await fill(user, region.getByLabelText('Chat id'), '@kestrel_ops')
    await user.click(region.getByRole('button', { name: 'Add channel' }))
    const token = region.getByLabelText('Bot token')
    await waitFor(() => expect(token).toHaveAttribute('aria-invalid', 'true'))
    expect(token).toHaveAccessibleDescription(/BotFather/)
  })

  it('edits without resending the token and sends only what changed', async () => {
    const api = mockApi({
      ...configuredRoutes(),
      'GET /notifications/channels': { items: [ntfyChannel] },
      [`PATCH /notifications/channels/${ntfyChannel.id}`]: ntfyChannel,
    })
    const user = userEvent.setup()
    await renderApp('/settings?sel=notifications')
    const region = within(await screen.findByRole('region', { name: 'Notification channels' }))
    expect(await region.findByText(/private addresses allowed/)).toBeInTheDocument()
    await user.click(region.getByRole('button', { name: /edit/i }))
    expect(region.getByLabelText('Access token')).toHaveValue('')
    expect(region.getByText('One is stored. Leave empty to keep it.')).toBeInTheDocument()
    await user.click(region.getByRole('checkbox', { name: /Allow private addresses/ }))
    await user.click(region.getByRole('button', { name: 'Save changes' }))
    await waitFor(() =>
      expect(api.called('PATCH', `/notifications/channels/${ntfyChannel.id}`)).toHaveLength(1),
    )
    expect(api.called('PATCH', `/notifications/channels/${ntfyChannel.id}`)[0]?.body).toEqual({
      allowPrivate: false,
    })
  })
})
