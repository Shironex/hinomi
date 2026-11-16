import { describe, expect, it } from 'vitest'
import { isPublicAddress } from './public-address.js'

// IPv6 forms that carry an IPv4 address are classified as that IPv4 address.

describe('isPublicAddress with IPv4 inside IPv6', () => {
  it.each([
    ['::ffff:127.0.0.1', 'IPv4 mapped'],
    ['::ffff:7f00:1', 'IPv4 mapped, hex'],
    ['::127.0.0.1', 'IPv4 compatible'],
    ['::7f00:1', 'IPv4 compatible, hex'],
    ['::a9fe:a9fe', 'IPv4 compatible metadata address'],
    ['::ffff:0:a9fe:a9fe', 'IPv4 translated metadata address'],
    ['::ffff:0:10.0.0.1', 'IPv4 translated'],
    ['64:ff9b::7f00:1', 'NAT64 loopback'],
    ['64:ff9b::169.254.169.254', 'NAT64 metadata address'],
    ['64:ff9b:1::1.1.1.1', 'local use NAT64'],
    ['2002:7f00:1::1', '6to4 loopback'],
    ['2002:a9fe:a9fe::', '6to4 metadata address'],
    ['2002:c0a8:0101::1', '6to4 private'],
    ['2001:0:4136:e378:8000:63bf:3fff:fdd2', 'Teredo'],
    ['fe80::1%eth0', 'link local with a zone'],
    ['fec0::1', 'site local'],
  ])('refuses %s (%s)', (address) => {
    expect(isPublicAddress(address)).toBe(false)
  })

  it.each([
    ['::ffff:1.1.1.1', 'IPv4 mapped public'],
    ['64:ff9b::808:808', 'NAT64 public'],
    ['2002:0808:0808::1', '6to4 public'],
    ['2606:4700:4700::1111', 'plain public IPv6'],
  ])('accepts %s (%s)', (address) => {
    expect(isPublicAddress(address)).toBe(true)
  })
})
