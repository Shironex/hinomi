import { FINDING_TIERS, REPO_RELEASE_STATUSES } from '@hinomi/shared'
import { describe, expect, it } from 'vitest'
import { repoDetail } from '@/fixtures/builders'
import { TIER_INFO, tierTitle } from './finding-meta'
import { releaseUrl, releaseVerdict } from './release-meta'

const release = (over: Partial<ReturnType<typeof repoDetail>['release']>) => ({
  ...repoDetail().release,
  ...over,
})

describe('release meta', () => {
  it('says why for every status, and only released applies the tier', () => {
    for (const status of REPO_RELEASE_STATUSES) {
      const verdict = releaseVerdict(release({ status }))
      expect(verdict.why.length, status).toBeGreaterThan(20)
      expect(verdict.released, status).toBe(status === 'released')
    }
  })

  it('names a mode set by hand when it decides the answer', () => {
    expect(releaseVerdict(release({ tier: 'auto' })).why).toMatch(/is in the hands of users/)
    expect(releaseVerdict(release({ tier: 'on' })).why).toMatch(/set to Always/)
    expect(releaseVerdict(release({ tier: 'off', status: 'turned_off' })).why).toMatch(
      /set to Never/,
    )
  })

  it('links the tag on GitHub with the tag escaped', () => {
    expect(releaseUrl('kestrel-co/kestrel-desk', 'v2.3.0')).toBe(
      'https://github.com/kestrel-co/kestrel-desk/releases/tag/v2.3.0',
    )
    expect(releaseUrl('kestrel-co/x', 'release/1 beta')).toBe(
      'https://github.com/kestrel-co/x/releases/tag/release%2F1%20beta',
    )
  })

  it('labels the released tier between internal and public low, in the shared order', () => {
    expect(TIER_INFO.released.name).toBe('Released desktop apps')
    expect(tierTitle('released')).toBe('Tier 3: Released desktop apps')
    const order = FINDING_TIERS.slice(0, FINDING_TIERS.indexOf('public_low'))
    expect(order.slice(-2)).toEqual(['internal', 'released'])
    // Every tier has words, so none renders as undefined.
    for (const tier of FINDING_TIERS) expect(TIER_INFO[tier].name, tier).toBeTruthy()
  })
})
