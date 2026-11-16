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

/**
 * The client a rate limit counts: an IPv4 address as is, an IPv6 address by its /64. One
 * subscriber or host usually holds a whole /64, so counting single IPv6 addresses would let
 * a client rotate through billions of fresh ones.
 */
export function rateLimitKey(ip: ParsedIp): string {
  if (ip.family === 'ipv4') return ip.address
  return `${expandIpv6(ip.address).slice(0, 4).join(':')}::/64`
}

/** The eight 16 bit groups of an IPv6 address, in short hex (`2001:db8:0:0:...`). */
function expandIpv6(address: string): string[] {
  let text = address
  // An IPv4 tail (`::ffff:192.0.2.1`, `64:ff9b::198.51.100.7`) becomes two groups.
  const tail = /(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(text)
  if (tail) {
    const [a, b, c, d] = tail.slice(1).map(Number) as [number, number, number, number]
    text = `${text.slice(0, tail.index)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`
  }
  const [head = '', rest] = text.split('::')
  const left = head ? head.split(':') : []
  const right = rest === undefined ? [] : rest ? rest.split(':') : []
  const fill: string[] =
    rest === undefined ? [] : Array.from({ length: 8 - left.length - right.length }, () => '0')
  return [...left, ...fill, ...right].map((group) => Number.parseInt(group, 16).toString(16))
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
