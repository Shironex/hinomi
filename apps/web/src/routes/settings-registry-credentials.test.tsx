import { currentTime } from '@hinomi/shared'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { REGISTRY_CREDENTIALS } from '@/fixtures/registry-credentials'
import { configuredRoutes, mockApi, reply } from '@/test/mock-api'
import { renderApp } from '@/test/render-app'

const SECRET = 'pat-fictional-secret-0001'
const BASE = '/settings/registry-credentials'

async function credentialsRegion() {
  return within(await screen.findByRole('region', { name: 'Registry credentials' }))
}

describe('settings: registry credentials', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('lists host and user name under Scans, never a secret', async () => {
    mockApi({ ...configuredRoutes(), [`GET ${BASE}`]: REGISTRY_CREDENTIALS })
    await renderApp('/settings?sel=scans')
    const region = await credentialsRegion()
    const list = within(await region.findByRole('list', { name: 'Registry credentials' }))
    expect(list.getByText('ghcr.io')).toBeInTheDocument()
    expect(list.getByText('kestrel-bot')).toBeInTheDocument()
    expect(list.getByText('registry.example.com:5000')).toBeInTheDocument()
    expect(list.getAllByText(/secret stored/)).toHaveLength(2)
  })

  it('adds a credential with a hint for the GHCR token scope', async () => {
    let items: unknown[] = []
    const api = mockApi({
      ...configuredRoutes(),
      [`GET ${BASE}`]: () => ({ items, canStoreSecrets: true }),
      [`POST ${BASE}`]: (body: { host: string; username: string }) => {
        const created = {
          id: 3,
          host: 'ghcr.io',
          username: body.username,
          secretSet: true,
          createdAt: currentTime().toISOString(),
          updatedAt: currentTime().toISOString(),
        }
        items = [created]
        return reply(201, created)
      },
    })
    const user = userEvent.setup()
    await renderApp('/settings?sel=scans')
    const region = await credentialsRegion()
    expect(await region.findByText(/No registry credentials/)).toBeInTheDocument()
    await user.click(region.getByRole('button', { name: 'Add registry credential' }))

    await user.click(region.getByRole('button', { name: 'Add credential' }))
    expect(region.getByText('Enter the registry host, for example ghcr.io.')).toBeInTheDocument()
    expect(api.called('POST', BASE)).toHaveLength(0)

    await user.type(region.getByLabelText('Registry host'), 'ghcr.io')
    expect(region.getByText(/read:packages/)).toBeInTheDocument()
    await user.type(region.getByLabelText('User name'), 'kestrel-bot')
    await user.type(region.getByLabelText('Password or token'), SECRET)
    await user.click(region.getByRole('button', { name: 'Add credential' }))

    await waitFor(() => expect(api.called('POST', BASE)).toHaveLength(1))
    expect(api.called('POST', BASE)[0]!.body).toEqual({
      host: 'ghcr.io',
      username: 'kestrel-bot',
      secret: SECRET,
    })
    expect(await region.findByText(/ghcr.io added/)).toBeInTheDocument()
    expect(document.body.textContent).not.toContain(SECRET)
  })

  it('shows a taken host by the host field', async () => {
    mockApi({
      ...configuredRoutes(),
      [`GET ${BASE}`]: { items: [], canStoreSecrets: true },
      [`POST ${BASE}`]: reply(409, {
        error: {
          code: 'conflict',
          message: 'A credential for ghcr.io already exists; edit it instead',
        },
      }),
    })
    const user = userEvent.setup()
    await renderApp('/settings?sel=scans')
    const region = await credentialsRegion()
    await user.click(await region.findByRole('button', { name: 'Add registry credential' }))
    await user.type(region.getByLabelText('Registry host'), 'ghcr.io')
    await user.type(region.getByLabelText('User name'), 'kestrel-bot')
    await user.type(region.getByLabelText('Password or token'), SECRET)
    await user.click(region.getByRole('button', { name: 'Add credential' }))
    expect(await region.findByText(/already exists/)).toBeInTheDocument()
    expect(region.getByLabelText('Registry host')).toHaveFocus()
  })

  it('replaces only the secret on edit and keeps it when left empty', async () => {
    const api = mockApi({
      ...configuredRoutes(),
      [`GET ${BASE}`]: REGISTRY_CREDENTIALS,
      [`PATCH ${BASE}/1`]: () => REGISTRY_CREDENTIALS.items[0],
    })
    const user = userEvent.setup()
    await renderApp('/settings?sel=scans')
    const region = await credentialsRegion()
    const list = within(await region.findByRole('list', { name: 'Registry credentials' }))
    await user.click(list.getAllByRole('button', { name: 'Edit' })[0]!)
    expect(region.queryByLabelText('Registry host')).not.toBeInTheDocument()
    await user.type(region.getByLabelText('New password or token'), SECRET)
    await user.click(region.getByRole('button', { name: 'Save changes' }))
    await waitFor(() => expect(api.called('PATCH', `${BASE}/1`)).toHaveLength(1))
    expect(api.called('PATCH', `${BASE}/1`)[0]!.body).toEqual({ secret: SECRET })
  })

  it('asks for HINOMI_SECRET_KEY instead of offering a form without it', async () => {
    mockApi({ ...configuredRoutes(), [`GET ${BASE}`]: { items: [], canStoreSecrets: false } })
    await renderApp('/settings?sel=scans')
    const region = await credentialsRegion()
    expect(await region.findByText(/Set HINOMI_SECRET_KEY/)).toBeInTheDocument()
    expect(region.queryByRole('button', { name: 'Add registry credential' })).toBeNull()
  })
})
