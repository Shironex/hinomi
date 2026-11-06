import { BlockList, isIP } from 'node:net'

export type IpFamily = 'ipv4' | 'ipv6'

export interface ParsedIp {
  address: string
  family: IpFamily
}

/**
 * Parses an address as Node reports it on a socket or a proxy writes it in a header.
 * IPv4 mapped IPv6 (`::ffff:192.0.2.1`, what a dual stack listener reports for an
 * IPv4 client) becomes plain IPv4, and a zone id (`fe80::1%eth0`) is dropped.
 */
export function parseIp(raw: string | undefined | null): ParsedIp | null {
  if (!raw) return null
  let address = raw.trim()
  // [2001:db8::1] as some proxies write it.
  if (address.startsWith('[') && address.endsWith(']')) address = address.slice(1, -1)
  const zone = address.indexOf('%')
  if (zone !== -1) address = address.slice(0, zone)
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(address)
  if (mapped?.[1]) address = mapped[1]
  const version = isIP(address)
  if (version === 4) return { address, family: 'ipv4' }
  if (version === 6) return { address: address.toLowerCase(), family: 'ipv6' }
  return null
}

export class InvalidCidrError extends Error {}

/**
 * Builds a matcher from entries like `10.0.0.0/8`, `172.20.0.3` or `fd00::/8`.
 * Throws InvalidCidrError naming the first entry that is not an address or range.
 */
export function createIpMatcher(entries: readonly string[]): (ip: ParsedIp) => boolean {
  const list = new BlockList()
  for (const entry of entries) {
    const [host, prefix, extra] = entry.trim().split('/')
    const ip = parseIp(host)
    const max = ip?.family === 'ipv4' ? 32 : 128
    const bits = prefix === undefined ? max : Number(prefix)
    if (!ip || extra !== undefined || !Number.isInteger(bits) || bits < 0 || bits > max) {
      throw new InvalidCidrError(`"${entry}" is not an IP address or CIDR range`)
    }
    list.addSubnet(ip.address, bits, ip.family)
  }
  return (ip) => list.check(ip.address, ip.family)
}

/** Tailscale node addresses: the CGNAT range for IPv4 and Tailscale's ULA prefix for IPv6. */
export const isTailscale = createIpMatcher(['100.64.0.0/10', 'fd7a:115c:a1e0::/48'])

export const isLoopback = createIpMatcher(['127.0.0.0/8', '::1/128'])

/**
 * Addresses that never come straight from the internet: private LANs, Docker bridge
 * networks (172.16.0.0/12 by default, other ranges when configured), link local,
 * unique local IPv6 and the unspecified address. Tailscale and loopback are checked
 * before this.
 */
export const isPrivate = createIpMatcher([
  '0.0.0.0/8',
  '10.0.0.0/8',
  '100.64.0.0/10',
  '169.254.0.0/16',
  '172.16.0.0/12',
  '192.168.0.0/16',
  '::/128',
  'fc00::/7',
  'fe80::/10',
])
