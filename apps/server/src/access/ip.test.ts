import { describe, expect, it } from 'vitest'
import { createIpMatcher, isLoopback, isPrivate, isTailscale, parseIp } from './ip.js'

describe('parseIp', () => {
  it('reads IPv4 and IPv6', () => {
    expect(parseIp('203.0.113.9')).toEqual({ address: '203.0.113.9', family: 'ipv4' })
    expect(parseIp('2001:DB8::1')).toEqual({ address: '2001:db8::1', family: 'ipv6' })
  })

  it('unwraps IPv4 mapped IPv6, brackets and zone ids', () => {
    expect(parseIp('::ffff:100.100.7.8')).toEqual({ address: '100.100.7.8', family: 'ipv4' })
    expect(parseIp('[2001:db8::1]')?.address).toBe('2001:db8::1')
    expect(parseIp('fe80::1%eth0')?.address).toBe('fe80::1')
  })

  it('rejects anything else', () => {
    expect(parseIp(undefined)).toBeNull()
    expect(parseIp('')).toBeNull()
    expect(parseIp('edge-1.example.dev')).toBeNull()
    expect(parseIp('203.0.113.9:443')).toBeNull()
  })
})

describe('ranges', () => {
  const ip = (raw: string) => parseIp(raw)!

  it('knows Tailscale addresses', () => {
    expect(isTailscale(ip('100.100.7.8'))).toBe(true)
    expect(isTailscale(ip('100.127.255.254'))).toBe(true)
    expect(isTailscale(ip('100.128.0.1'))).toBe(false)
    expect(isTailscale(ip('fd7a:115c:a1e0::42'))).toBe(true)
    expect(isTailscale(ip('fd7a:115c:a1e1::42'))).toBe(false)
  })

  it('knows loopback and private ranges, including Docker bridges', () => {
    expect(isLoopback(ip('127.0.0.1'))).toBe(true)
    expect(isLoopback(ip('::1'))).toBe(true)
    for (const raw of [
      '172.17.0.1',
      '172.31.255.1',
      '10.0.1.5',
      '192.168.1.20',
      'fd00::5',
      'fe80::1',
    ]) {
      expect(isPrivate(ip(raw)), raw).toBe(true)
    }
    for (const raw of ['203.0.113.9', '198.51.100.4', '2001:db8::1', '172.32.0.1']) {
      expect(isPrivate(ip(raw)), raw).toBe(false)
    }
  })
})

describe('createIpMatcher', () => {
  it('matches single addresses and ranges', () => {
    const match = createIpMatcher(['172.20.0.0/16', '10.0.0.7', 'fd00::/8'])
    expect(match(parseIp('172.20.3.4')!)).toBe(true)
    expect(match(parseIp('10.0.0.7')!)).toBe(true)
    expect(match(parseIp('10.0.0.8')!)).toBe(false)
    expect(match(parseIp('fd00::1')!)).toBe(true)
  })

  it('names the entry it cannot read', () => {
    expect(() => createIpMatcher(['10.0.0.0/33'])).toThrow('"10.0.0.0/33"')
    expect(() => createIpMatcher(['proxy.example.dev'])).toThrow('"proxy.example.dev"')
    expect(() => createIpMatcher(['10.0.0.0/8/1'])).toThrow(/not an IP address/)
  })
})
