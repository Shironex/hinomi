import type { LockfileDependency } from '@hinomi/shared'
import { describe, expect, it } from 'vitest'
import { inGithubRange, installedFromLockfiles } from './installed.js'

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

describe('installedFromLockfiles', () => {
  const alert = { package: 'plover-parse', ecosystem: 'npm', manifestPath: 'pnpm-lock.yaml' }

  it('reads the version from the lockfile the alert names', () => {
    const deps = [
      dep('plover-parse', '1.2.0', 'pnpm-lock.yaml'),
      dep('wren', '1.0.0', 'pnpm-lock.yaml'),
    ]
    expect(installedFromLockfiles(deps, alert, '< 1.2.5')).toBe('1.2.0')
  })

  it('prefers the named lockfile, then its folder, then any', () => {
    const deps = [
      dep('plover-parse', '1.0.0', 'apps/web/pnpm-lock.yaml'),
      dep('plover-parse', '1.1.0', 'pnpm-lock.yaml'),
    ]
    expect(installedFromLockfiles(deps, alert, null)).toBe('1.1.0')
    const nested = { ...alert, manifestPath: 'apps/web/package.json' }
    expect(installedFromLockfiles(deps, nested, null)).toBe('1.0.0')
    const elsewhere = { ...alert, manifestPath: 'tools/package.json' }
    expect(installedFromLockfiles(deps, elsewhere, null)).toBe('1.0.0, 1.1.0')
  })

  it('narrows several versions to the vulnerable ones', () => {
    const deps = [
      dep('plover-parse', '1.2.0', 'pnpm-lock.yaml'),
      dep('plover-parse', '2.0.0', 'pnpm-lock.yaml'),
    ]
    expect(installedFromLockfiles(deps, alert, '< 1.2.5')).toBe('1.2.0')
  })

  it('matches cargo crates by the GitHub ecosystem name', () => {
    const crate = { ...dep('heron-core', '0.4.1', 'Cargo.lock'), ecosystem: 'crates.io' as const }
    const cargoAlert = { package: 'heron-core', ecosystem: 'rust', manifestPath: 'Cargo.lock' }
    expect(installedFromLockfiles([crate], cargoAlert, null)).toBe('0.4.1')
  })

  it('is undefined when no lockfile lists the package', () => {
    expect(installedFromLockfiles([dep('wren', '1.0.0', 'pnpm-lock.yaml')], alert, null)).toBe(
      undefined,
    )
  })
})
