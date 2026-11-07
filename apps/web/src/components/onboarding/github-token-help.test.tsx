import { render, screen, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { presetTokenUrl } from '@/lib/github-token-url'
import { GithubTokenHelp } from './github-token-help'

describe('GithubTokenHelp', () => {
  it('links to a prefilled classic and fine grained token and lists the fine grained permissions', () => {
    render(<GithubTokenHelp />)
    const help = screen.getByRole('region', { name: 'Create a GitHub token' })

    const classic = within(help).getByRole('link', { name: 'Create a classic token' })
    const url = new URL(classic.getAttribute('href') ?? '')
    expect(url.origin + url.pathname).toBe('https://github.com/settings/tokens/new')
    expect(url.searchParams.get('scopes')).toBe('repo,security_events')
    expect(url.searchParams.get('description')).toBe('Hinomi')
    expect(classic).toHaveAttribute('target', '_blank')
    expect(classic).toHaveAttribute('rel', 'noreferrer noopener')

    const fine = within(help).getByRole('link', { name: 'Create a fine grained token' })
    expect(fine).toHaveAttribute('href', presetTokenUrl('reading'))
    expect(fine).toHaveAttribute('target', '_blank')
    expect(fine).toHaveAttribute('rel', 'noreferrer noopener')
    const permissions = within(help)
      .getAllByRole('listitem')
      .map((li) => li.querySelector('b')?.textContent)
    expect(permissions).toEqual([
      'Metadata: read',
      'Contents: read',
      'Dependabot alerts: read',
      'Administration: read',
    ])
    expect(
      within(help)
        .getByText(/Administration/)
        .closest('li'),
    ).toHaveTextContent(/optional/)
    expect(within(help).getByText('Only select repositories')).toBeInTheDocument()

    expect(within(help).getByText(/Configure SSO/)).toBeInTheDocument()
  })
})
