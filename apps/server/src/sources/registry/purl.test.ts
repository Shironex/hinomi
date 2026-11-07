import { describe, expect, it } from 'vitest'
import { imagePackageOf, parsePurl } from './purl.js'
import { packagesOf } from './read.js'

const pkg = (raw: string) => {
  const purl = parsePurl(raw)
  return purl && imagePackageOf(purl)
}

describe('parsePurl', () => {
  it('reads type, namespace, name, version and qualifiers', () => {
    const purl = parsePurl(
      'pkg:deb/debian/libc6@2.36-9%2Bdeb12u4?arch=amd64&upstream=glibc&distro=debian-12#sub',
    )
    expect(purl).toMatchObject({
      type: 'deb',
      namespace: ['debian'],
      name: 'libc6',
      version: '2.36-9+deb12u4',
    })
    expect(purl?.qualifiers.get('upstream')).toBe('glibc')
    expect(purl?.qualifiers.get('distro')).toBe('debian-12')
  })

  it('reads npm scopes, encoded or not', () => {
    expect(parsePurl('pkg:npm/%40kestrel-co/edge-utils@2.0.0')).toMatchObject({
      namespace: ['@kestrel-co'],
      name: 'edge-utils',
      version: '2.0.0',
    })
    expect(parsePurl('pkg:npm/@kestrel-co/edge-utils@2.0.0')?.namespace).toEqual(['@kestrel-co'])
  })

  it('drops what is not a purl with a version', () => {
    expect(parsePurl('cpe:2.3:a:openssl:openssl:3.0.0')).toBeNull()
    expect(parsePurl('pkg:npm/left-pad')).toBeNull()
    expect(parsePurl('pkg:npm@1.0.0')).toBeNull()
    expect(parsePurl('pkg:npm/%E0%A4%A@1.0.0')).toBeNull()
    expect(parsePurl(`pkg:npm/${'a'.repeat(2000)}@1.0.0`)).toBeNull()
  })

  it('keeps qualifiers in a Map, so __proto__ and constructor are plain keys', () => {
    const purl = parsePurl(
      'pkg:apk/alpine/musl@1.2.5-r0?__proto__=polluted&constructor=x&distro=alpine-3.20.2',
    )
    expect(purl?.qualifiers.get('__proto__')).toBe('polluted')
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
    expect(Object.prototype).not.toHaveProperty('polluted')
    expect(pkg('pkg:apk/alpine/musl@1.2.5-r0?__proto__=x&distro=alpine-3.20.2')?.ecosystem).toBe(
      'Alpine:v3.20',
    )
  })
})

describe('imagePackageOf', () => {
  it('maps Syft distro qualifiers and the upstream source package', () => {
    expect(
      pkg('pkg:apk/alpine/libcrypto3@3.3.1-r0?arch=x86_64&distro=alpine-3.20.2&upstream=openssl'),
    ).toEqual({
      ecosystem: 'Alpine:v3.20',
      name: 'openssl',
      version: '3.3.1-r0',
      packageType: 'apk',
      storedEcosystem: 'apk',
      localCheck: false,
    })
    expect(
      pkg('pkg:deb/debian/libsystemd0@252.22-1?distro=debian-12&upstream=systemd%40252.21-1'),
    ).toMatchObject({ ecosystem: 'Debian:12', name: 'systemd', version: '252.21-1' })
    expect(
      pkg('pkg:deb/debian/libc6@2.36-9?distro=debian-12&upstream=glibc%20(2.36-8)'),
    ).toMatchObject({ name: 'glibc', version: '2.36-8' })
  })

  it('maps Docker Scout os qualifiers and Debian code names', () => {
    expect(
      pkg('pkg:deb/debian/acl@2.3.1-3?os_distro=bookworm&os_name=debian&os_version=12'),
    ).toMatchObject({ ecosystem: 'Debian:12', name: 'acl' })
    expect(pkg('pkg:apk/alpine/zlib@1.3.1-r1?os_name=alpine&os_version=3.20')).toMatchObject({
      ecosystem: 'Alpine:v3.20',
    })
    expect(pkg('pkg:deb/debian/zlib1g@1.2.13?distro=bookworm')).toMatchObject({
      ecosystem: 'Debian:12',
    })
  })

  it('names Ubuntu LTS releases the way OSV does', () => {
    expect(pkg('pkg:deb/ubuntu/bash@5.2?distro=ubuntu-24.04')?.ecosystem).toBe('Ubuntu:24.04:LTS')
    expect(pkg('pkg:deb/ubuntu/bash@5.2?distro=ubuntu-24.10')?.ecosystem).toBe('Ubuntu:24.10')
    expect(pkg('pkg:deb/ubuntu/bash@5.1?distro=ubuntu-23.04')?.ecosystem).toBe('Ubuntu:23.04')
  })

  it('maps language packages to OSV and stored ecosystems', () => {
    expect(pkg('pkg:golang/golang.org/x/net@v0.20.0')).toMatchObject({
      ecosystem: 'Go',
      name: 'golang.org/x/net',
      version: '0.20.0',
      storedEcosystem: 'Go',
      localCheck: true,
    })
    expect(pkg('pkg:golang/stdlib@go1.22.1')).toMatchObject({ name: 'stdlib', version: '1.22.1' })
    expect(pkg('pkg:cargo/edge-codec@0.4.1')).toMatchObject({
      ecosystem: 'crates.io',
      storedEcosystem: 'rust',
    })
    expect(pkg('pkg:maven/dev.example/edge-core@1.0.0')).toMatchObject({
      ecosystem: 'Maven',
      name: 'dev.example:edge-core',
      localCheck: false,
    })
    expect(pkg('pkg:pypi/Edge-Client@1.0.0')?.name).toBe('edge-client')
  })

  it('skips what OSV cannot match', () => {
    expect(pkg('pkg:generic/composer@2.7.0')).toBeNull()
    expect(pkg('pkg:deb/debian/acl@2.3.1-3')).toBeNull()
    expect(pkg('pkg:rpm/redhat/openssl@3.0.7-27.el9?distro=rhel-9.4')).toBeNull()
    expect(pkg('pkg:rpm/rocky/openssl@3.0.7?distro=rocky-9.4')?.ecosystem).toBe('Rocky Linux:9')
    expect(pkg('pkg:apk/wolfi/glibc@2.39-r1')?.ecosystem).toBe('Wolfi')
  })
})

describe('packagesOf', () => {
  it('dedupes binary packages of one source package and counts the skipped ones', () => {
    const { packages, skipped } = packagesOf([
      'pkg:apk/alpine/libcrypto3@3.3.1-r0?distro=alpine-3.20.2&upstream=openssl',
      'pkg:apk/alpine/libssl3@3.3.1-r0?distro=alpine-3.20.2&upstream=openssl',
      'pkg:generic/composer@2.7.0',
      'not a purl',
    ])
    expect(packages.map((p) => p.name)).toEqual(['openssl'])
    expect(skipped).toBe(2)
  })
})
