import type { LockfileDependency } from '@hinomi/shared'
import { describe, expect, it } from 'vitest'
import { inGithubRange, isPatchedVersion, resolveFromLockfiles } from './installed.js'

// Fictional packages only.

const dep = (name: string, version: string, lockfile: string): LockfileDependency => ({
  name,
  version,
  ecosystem: 'npm',
  scope: 'runtime',
  direct: false,
  lockfile,
})

describe('inGithubRange', () => {
  it('reads the operators GitHub uses', () => {
    expect(inGithubRange('1.2.0', '< 1.2.5')).toBe(true)
    expect(inGithubRange('1.2.5', '< 1.2.5')).toBe(false)
    expect(inGithubRange('1.2.0', '>= 1.0.0, < 1.2.5')).toBe(true)
    expect(inGithubRange('0.9.0', '>= 1.0.0, < 1.2.5')).toBe(false)
    expect(inGithubRange('4.17.20', '= 4.17.20')).toBe(true)
    expect(inGithubRange('2.0.0', '<= 2.0.0')).toBe(true)
  })
})

describe('resolveFromLockfiles', () => {
  const alert = { package: 'plover-parse', ecosystem: 'npm', manifestPath: 'pnpm-lock.yaml' }

  it('reads the version from the lockfile the alert names', () => {
    const deps = [
      dep('plover-parse', '1.2.0', 'pnpm-lock.yaml'),
      dep('wren', '1.0.0', 'pnpm-lock.yaml'),
    ]
    expect(resolveFromLockfiles(deps, alert, '< 1.2.5', null).installed).toBe('1.2.0')
  })

  it('prefers the named lockfile, then its folder, then any', () => {
    const deps = [
      dep('plover-parse', '1.0.0', 'apps/web/pnpm-lock.yaml'),
      dep('plover-parse', '1.1.0', 'pnpm-lock.yaml'),
    ]
    expect(resolveFromLockfiles(deps, alert, null, null).installed).toBe('1.1.0')
    const nested = { ...alert, manifestPath: 'apps/web/package.json' }
    expect(resolveFromLockfiles(deps, nested, null, null).installed).toBe('1.0.0')
    const elsewhere = { ...alert, manifestPath: 'tools/package.json' }
    expect(resolveFromLockfiles(deps, elsewhere, null, null).installed).toBe('1.0.0, 1.1.0')
  })

  it('narrows several versions to the vulnerable ones', () => {
    const deps = [
      dep('plover-parse', '1.2.0', 'pnpm-lock.yaml'),
      dep('plover-parse', '2.0.0', 'pnpm-lock.yaml'),
    ]
    expect(resolveFromLockfiles(deps, alert, '< 1.2.5', null).installed).toBe('1.2.0')
  })

  it('matches cargo crates by the GitHub ecosystem name', () => {
    const crate = { ...dep('heron-core', '0.4.1', 'Cargo.lock'), ecosystem: 'crates.io' as const }
    const cargoAlert = { package: 'heron-core', ecosystem: 'rust', manifestPath: 'Cargo.lock' }
    expect(resolveFromLockfiles([crate], cargoAlert, null, null).installed).toBe('0.4.1')
  })

  it('is undefined when no lockfile lists the package', () => {
    expect(
      resolveFromLockfiles([dep('wren', '1.0.0', 'pnpm-lock.yaml')], alert, null, null).installed,
    ).toBe(undefined)
  })
})

describe('isPatchedVersion', () => {
  it('uses the vulnerable range when there is one', () => {
    expect(isPatchedVersion('4.7.10', '>= 4.0.0, < 4.7.9', '4.7.9')).toBe(true)
    expect(isPatchedVersion('4.7.8', '>= 4.0.0, < 4.7.9', '4.7.9')).toBe(false)
    expect(isPatchedVersion('3.9.0', '>= 4.0.0, < 4.7.9', '4.7.9')).toBe(true)
  })

  it('compares with the first patched version when the range is missing or blank', () => {
    expect(isPatchedVersion('4.7.10', null, '4.7.10')).toBe(true)
    expect(isPatchedVersion('4.7.11', '', '4.7.10')).toBe(true)
    expect(isPatchedVersion('4.7.9', '  ', '4.7.10')).toBe(false)
    expect(isPatchedVersion('4.10.0', null, '4.7.10')).toBe(true)
  })

  it('treats a prerelease as older than its release', () => {
    expect(isPatchedVersion('4.7.10-rc.1', null, '4.7.10')).toBe(false)
    expect(isPatchedVersion('4.7.11-beta.1', null, '4.7.10')).toBe(true)
    expect(isPatchedVersion('4.7.10-rc.1', '< 4.7.10', '4.7.10')).toBe(false)
  })

  it('is never patched without a range or a first patched version, or with an unreadable one', () => {
    expect(isPatchedVersion('1.0.0', null, null)).toBe(false)
    expect(isPatchedVersion('workspace:*', null, '1.0.0')).toBe(false)
    expect(isPatchedVersion('2.0.0', null, 'latest')).toBe(false)
  })
})

describe('resolveFromLockfiles patched state', () => {
  const alert = { package: 'plover-parse', ecosystem: 'npm', manifestPath: 'pnpm-lock.yaml' }

  it('is patched only when every resolved version is patched', () => {
    const patched = [
      dep('plover-parse', '1.2.5', 'pnpm-lock.yaml'),
      dep('plover-parse', '2.0.0', 'pnpm-lock.yaml'),
    ]
    expect(resolveFromLockfiles(patched, alert, null, '1.2.5')).toEqual({
      installed: '1.2.5, 2.0.0',
      patched: true,
    })
    const mixed = [...patched, dep('plover-parse', '1.0.0', 'pnpm-lock.yaml')]
    expect(resolveFromLockfiles(mixed, alert, '< 1.2.5', '1.2.5')).toEqual({
      installed: '1.0.0',
      patched: false,
    })
  })

  it('is not patched when no lockfile lists the package', () => {
    expect(resolveFromLockfiles([], alert, '< 1.2.5', '1.2.5')).toEqual({
      installed: undefined,
      patched: false,
    })
  })
})
