import { describe, expect, it } from 'vitest'
import { installerAssets, isInstallerAsset } from './releases.js'

describe('installer heuristic', () => {
  it('counts platform installers and packages whatever the case', () => {
    for (const name of [
      'Kestrel-2.3.0-universal.dmg',
      'Kestrel-Setup-2.3.0.exe',
      'Kestrel-2.3.0.msi',
      'Kestrel-2.3.0.pkg',
      'Kestrel-2.3.0.msix',
      'Kestrel-2.3.0.AppImage',
      'kestrel_2.3.0_amd64.deb',
      'kestrel-2.3.0.x86_64.rpm',
      'dev.example.Kestrel.flatpak',
      'kestrel_2.3.0_amd64.snap',
      'kestrel-2.3.0.apk',
      'kestrel-2.3.0.aab',
    ]) {
      expect(isInstallerAsset(name), name).toBe(true)
    }
  })

  it('counts archives only when the name names a platform or a cpu', () => {
    expect(isInstallerAsset('Kestrel-2.3.0-arm64-mac.zip')).toBe(true)
    expect(isInstallerAsset('kestrel-win-x64.zip')).toBe(true)
    expect(isInstallerAsset('kestrel_1.0.0_linux_amd64.tar.gz')).toBe(true)
    expect(isInstallerAsset('kestrel-1.0.0-x86_64-unknown-linux-gnu.tar.xz')).toBe(true)
    expect(isInstallerAsset('kestrel-1.0.0-darwin.tgz')).toBe(true)
    expect(isInstallerAsset('kestrel-1.0.0.zip')).toBe(false)
    expect(isInstallerAsset('kestrel-1.0.0.tar.gz')).toBe(false)
  })

  it('matches platform words as whole tokens, not inside other words', () => {
    expect(isInstallerAsset('kestrel-twin-1.0.0.zip')).toBe(false)
    expect(isInstallerAsset('darwinism-notes.zip')).toBe(false)
    expect(isInstallerAsset('kestrel-maclean.tar.gz')).toBe(false)
  })

  it('never counts symbols, sources, checksums, signatures or update feeds', () => {
    for (const name of [
      'kestrel-2.3.0-linux-x64-debug-symbols.zip',
      'Kestrel-2.3.0-mac-dSYM.zip',
      'kestrel-2.3.0-win-x64-pdb.zip',
      'kestrel-2.3.0-src.tar.gz',
      'kestrel-2.3.0-source-linux.tar.gz',
      'Kestrel-Setup-2.3.0.exe.blockmap',
      'Kestrel-2.3.0-universal.dmg.sha256',
      'Kestrel-2.3.0-universal.dmg.asc',
      'latest-mac.yml',
      'checksums.txt',
      'sbom.spdx.json',
      '',
    ]) {
      expect(isInstallerAsset(name), name).toBe(false)
    }
  })

  it('reads names like __proto__ as plain strings', () => {
    expect(isInstallerAsset('__proto__')).toBe(false)
    expect(isInstallerAsset('constructor-win-x64.zip')).toBe(true)
    expect(isInstallerAsset('prototype.tar.gz')).toBe(false)
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
  })

  it('keeps the installable names in order', () => {
    expect(
      installerAssets([
        'latest.yml',
        'Kestrel-Setup-2.3.0.exe',
        'Kestrel-Setup-2.3.0.exe.blockmap',
        'Kestrel-2.3.0-universal.dmg',
      ]),
    ).toEqual(['Kestrel-Setup-2.3.0.exe', 'Kestrel-2.3.0-universal.dmg'])
  })
})
