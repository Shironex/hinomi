import { describe, expect, it } from 'vitest'
import {
  fineGrainedTokenUrl,
  ownerOf,
  presetTokenUrl,
  READING_PERMISSIONS,
  RUNNER_PERMISSIONS,
} from './github-token-url'

describe('fineGrainedTokenUrl', () => {
  it('encodes the name, description, owner, expiry and permissions in order', () => {
    expect(
      fineGrainedTokenUrl({
        name: 'My token',
        description: 'Reads & writes',
        owner: 'kestrel-co',
        permissions: [
          { param: 'contents', level: 'read', label: 'Contents', purpose: 'x' },
          { param: 'pull_requests', level: 'write', label: 'Pull requests', purpose: 'y' },
        ],
      }),
    ).toBe(
      'https://github.com/settings/personal-access-tokens/new?name=My+token&description=Reads+%26+writes&target_name=kestrel-co&expires_in=90&contents=read&pull_requests=write',
    )
  })

  it('leaves target_name out without an owner', () => {
    const url = new URL(fineGrainedTokenUrl({ name: 'a', description: 'b', permissions: [] }))
    expect(url.searchParams.has('target_name')).toBe(false)
    expect(url.searchParams.get('expires_in')).toBe('90')
  })
})

describe('presetTokenUrl', () => {
  it('prefills the reading set, administration included as an optional read', () => {
    expect(presetTokenUrl('reading')).toBe(
      'https://github.com/settings/personal-access-tokens/new?name=Hinomi&description=Hinomi+reads+advisories%2C+lockfiles+and+Dependabot+alerts&expires_in=90&metadata=read&contents=read&vulnerability_alerts=read&administration=read',
    )
    expect(READING_PERMISSIONS.filter((p) => p.optional).map((p) => p.param)).toEqual([
      'administration',
    ])
  })

  it('prefills the runner set for the repo owner, workflows only as an optional write', () => {
    expect(presetTokenUrl('runner', 'kestrel-co')).toBe(
      'https://github.com/settings/personal-access-tokens/new?name=Hinomi+runner&description=The+Hinomi+fix+runner+opens+fix+pull+requests&target_name=kestrel-co&expires_in=90&actions=write&contents=write&workflows=write&pull_requests=write&statuses=read&vulnerability_alerts=read&metadata=read',
    )
    expect(RUNNER_PERMISSIONS.filter((p) => p.optional).map((p) => p.param)).toEqual(['workflows'])
  })

  it('never asks for Checks, which is not a fine grained token permission', () => {
    for (const permission of [...READING_PERMISSIONS, ...RUNNER_PERMISSIONS]) {
      expect(permission.param).not.toBe('checks')
    }
  })
})

describe('ownerOf', () => {
  it('reads the owner of a full repo name', () => {
    expect(ownerOf('kestrel-co/harbor')).toBe('kestrel-co')
    expect(ownerOf('')).toBeNull()
    expect(ownerOf(undefined)).toBeNull()
  })
})
