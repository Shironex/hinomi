import { describe, expect, it } from 'vitest'
import {
  commitFromLabels,
  domainsFromLabels,
  hostsOfTraefikRule,
  projectOf,
  repoFromLabels,
} from './labels.js'

describe('repoFromLabels', () => {
  it('prefers hinomi.repo, then the OCI source label', () => {
    expect(repoFromLabels({ 'hinomi.repo': 'kestrel-co/kestrel-api' }).repo).toBe(
      'kestrel-co/kestrel-api',
    )
    expect(
      repoFromLabels({
        'org.opencontainers.image.source': 'https://github.com/kestrel-co/kestrel-blog.git',
      }),
    ).toEqual({
      repo: 'kestrel-co/kestrel-blog',
      raw: 'https://github.com/kestrel-co/kestrel-blog.git',
    })
    expect(repoFromLabels({})).toEqual({ repo: null, raw: null })
    expect(repoFromLabels({ 'hinomi.repo': 'not a repo' }).repo).toBeNull()
  })
})

describe('commitFromLabels', () => {
  it('keeps only a full sha', () => {
    expect(commitFromLabels({ 'org.opencontainers.image.revision': 'A'.repeat(40) })).toBe(
      'a'.repeat(40),
    )
    expect(commitFromLabels({ 'org.opencontainers.image.revision': 'v1.2.3' })).toBeNull()
  })
})

describe('domainsFromLabels', () => {
  it('reads hinomi.domains first, https when no scheme is given', () => {
    expect(
      domainsFromLabels({
        'hinomi.domains': 'app.example.com, http://old.example.com/ bad/path, app.example.com',
        'traefik.http.routers.x.rule': 'Host(`ignored.example.com`)',
      }),
    ).toEqual({ domains: ['https://app.example.com', 'http://old.example.com'], origin: 'hinomi' })
  })

  it('reads Traefik routers, https only with TLS or a secure entrypoint', () => {
    expect(
      domainsFromLabels({
        'traefik.http.routers.a.rule': 'Host(`a.example.com`) && PathPrefix(`/api`)',
        'traefik.http.routers.a.tls': 'true',
        'traefik.http.routers.b.rule': 'Host(`b.example.com`, `c.example.com`)',
        'traefik.http.routers.b.entrypoints': 'web',
        'traefik.http.routers.c.rule': 'HostRegexp(`{sub:[a-z]+}.example.com`)',
      }).domains,
    ).toEqual(['https://a.example.com', 'http://b.example.com', 'http://c.example.com'])
  })

  it('ignores Traefik when the container turns it off', () => {
    expect(
      domainsFromLabels({
        'traefik.enable': 'false',
        'traefik.http.routers.a.rule': 'Host(`a.example.com`)',
      }).domains,
    ).toEqual([])
  })

  it('reads Caddy site addresses and skips templates', () => {
    expect(
      domainsFromLabels({
        caddy: 'shop.example.com',
        caddy_1: 'http://plain.example.com:8080',
        caddy_2: '{{upstreams}}',
        'caddy.reverse_proxy': '{{upstreams 3000}}',
      }),
    ).toEqual({
      domains: ['https://shop.example.com', 'http://plain.example.com'],
      origin: 'caddy',
    })
  })

  it('rejects values that are not host names', () => {
    expect(hostsOfTraefikRule('Host(`a.example.com`) || Host("b.example.com")')).toEqual([
      'a.example.com',
      'b.example.com',
    ])
    expect(domainsFromLabels({ 'hinomi.domains': 'javascript:alert(1) <x>' }).domains).toEqual([])
  })
})

describe('projectOf', () => {
  it('takes the compose project, then hinomi.project, then the name', () => {
    expect(projectOf({ 'com.docker.compose.project': 'p', 'hinomi.project': 'q' }, 'n')).toBe('p')
    expect(projectOf({ 'hinomi.project': 'q' }, 'n')).toBe('q')
    expect(projectOf({}, 'n')).toBe('n')
  })
})
