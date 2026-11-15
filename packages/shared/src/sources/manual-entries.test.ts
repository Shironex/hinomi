import { describe, expect, it } from 'vitest'
import { defaultReach, parseManualYaml } from './manual-entries.js'

describe('parseManualYaml', () => {
  it('reads entries and fills the defaults', () => {
    const result = parseManualYaml(
      'deployments:\n  - name: billing\n    repo: example-org/billing\n    domains: [https://b.example.com/]\n',
    )
    expect(result).toEqual({
      ok: true,
      entries: [
        {
          name: 'billing',
          repo: 'example-org/billing',
          branch: null,
          image: null,
          domains: ['https://b.example.com'],
          reach: 'public',
          server: null,
        },
      ],
    })
  })

  it.each([
    ['unknown key', 'deployments:\n  - name: a\n    typo: 1\n'],
    ['alias', 'deployments:\n  - &a {name: x}\n  - *a\n'],
    ['custom tag', 'deployments:\n  - !!js/function name\n'],
    ['bad repo', 'deployments:\n  - name: a\n    repo: nope\n'],
    ['duplicate name', 'deployments:\n  - name: a\n  - name: a\n'],
    ['wrong top level', '- name: a\n'],
  ])('refuses %s', (_, text) => {
    expect(parseManualYaml(text).ok).toBe(false)
  })

  it('defaults the reach to unknown without a URL', () => {
    expect(defaultReach(['host.example.com'])).toBe('unknown')
  })
})
