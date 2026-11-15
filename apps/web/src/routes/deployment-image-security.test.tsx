import { screen, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { deploymentDetail, mockViews } from '@/test/fixtures'
import { renderApp } from '@/test/render-app'
import { safeHttpUrl } from '@/lib/image-security-meta'

const security = {
  status: 'update_now' as const,
  anyExploited: true,
  exploitedCount: 2,
  actions: [
    {
      type: 'update_image',
      sentence: '<img src=x onerror=alert(1)> Update to 3.24',
      target: '3.24',
      image: 'registry.example.dev/imgproxy:3.21',
    },
    { type: 'link', sentence: 'javascript:alert(1)', target: null, image: null },
    { type: 'link', sentence: 'https://example.com/guide', target: null, image: null },
  ],
  eol: { name: 'Debian', version: '10', fixed: false },
  checkedAt: '2026-11-14T10:00:00.000Z',
}

describe('image security on the deployment page', () => {
  it('shows the verdict, exploited count, actions as plain text and the end of life OS', async () => {
    mockViews({
      'GET /deployments/1': deploymentDetail({ id: 1, imageSecurity: security }),
    })
    await renderApp('/deployments/1')
    const panel = (await screen.findByRole('heading', { name: 'Image security' })).closest(
      'div',
    )!.parentElement!
    expect(within(panel).getByText('Update now')).toBeInTheDocument()
    expect(within(panel).getByText('2 exploited')).toBeInTheDocument()
    const actions = within(panel).getByRole('list', { name: 'Recommended actions' })
    expect(within(actions).getAllByRole('listitem')).toHaveLength(3)
    expect(actions.querySelector('img')).toBeNull()
    expect(within(actions).getByText(/<img src=x/)).toBeInTheDocument()
    expect(within(actions).queryByRole('link', { name: /javascript:/ })).toBeNull()
    expect(
      within(actions).getByRole('link', { name: 'https://example.com/guide' }),
    ).toHaveAttribute('href', 'https://example.com/guide')
    expect(within(panel).getByText(/Debian 10/)).toBeInTheDocument()
  })

  it('shows nothing until an image scan has read the deployment', async () => {
    mockViews({ 'GET /deployments/1': deploymentDetail({ id: 1, imageSecurity: null }) })
    await renderApp('/deployments/1')
    await screen.findByRole('heading', { level: 1 })
    expect(screen.queryByRole('heading', { name: 'Image security' })).toBeNull()
  })
})

describe('safeHttpUrl', () => {
  it('accepts only http and https', () => {
    expect(safeHttpUrl('https://example.com/a')).toBe('https://example.com/a')
    expect(safeHttpUrl('javascript:alert(1)')).toBeNull()
    expect(safeHttpUrl('data:text/html,x')).toBeNull()
    expect(safeHttpUrl('not a url')).toBeNull()
    expect(safeHttpUrl(null)).toBeNull()
  })
})
